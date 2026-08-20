// Trust Tai Ops — server-side reasoning boundary.
//
// The browser never talks to a model and never holds a model credential. This
// function proves the caller belongs to the project, asks a model a question,
// and returns only answers that survive validation.
//
// Modes that share the boundary:
//   plan_next_agent_turn   — the next read-only inspection, from a closed catalog.
//   analyze_meeting_source — what a client meeting means for this project.
//   compose_reply          — the spoken reply, streamed.
//   synthesize_diagnosis   — all evidence in, causal chains out (4K budget).
//
// Nothing here executes a tool, approves anything, or mutates WordPress.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import {
  loadMemoryIndex,
  loadKnowledgeBasePatterns,
  loadProjectContext,
  loadRetrievedConversation,
  loadRunEvidence,
  runBelongsToProject,
} from "../_shared/contextLoader.ts";
import { validateReasonPlan } from "../_shared/reasonCatalog.ts";
import { readModelText, resolveReasonModel, type ReasonModel } from "../_shared/reasonModels.ts";
import {
  SYSTEM_PROMPT,
  SYNTHESIS_SYSTEM_PROMPT,
  FIX_PLAN_SYSTEM_PROMPT,
  parseModelJson,
  parseFixPlan,
  sanitizeDigest,
  sanitizeSynthesisDigest,
  sanitizeFixDigest,
  synthesisUserPrompt,
  fixPlanUserPrompt,
  userPromptWithRecall,
  type RetrievedConversation,
  type SynthesisDigest,
  type FixDigest,
} from "../_shared/reasonPrompt.ts";
import type { ReasonDigest, ServerEvidence } from "../_shared/reasonPrompt.ts";
import { REPLY_SYSTEM_PROMPT, replyUserPrompt, sanitizeReplyFacts } from "../_shared/replyPrompt.ts";
import { MEETING_PROMPT_VERSION, MEETING_SYSTEM_PROMPT, meetingUserPrompt } from "../_shared/meetingPrompt.ts";
import { candidateKeyFor, taskKeyFor, validateMeetingAnalysis } from "../_shared/meetingSchema.ts";
import { mergeMeetingAnalyses } from "../_shared/meetingMerge.ts";
import { detectMemoryConflict, matchProposalToWork, type ExistingWork } from "../_shared/meetingMatch.ts";
import { renderProjectContext } from "../_shared/projectContext.ts";
import { chunkTranscript, fingerprintAnalysisContext, planTranscriptCoverage } from "../_shared/transcript.ts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 1200;
const REPLY_MAX_OUTPUT_TOKENS = 400;
const MEETING_TIMEOUT_MS = 90_000;
const MEETING_MAX_OUTPUT_TOKENS = 8_000;
const SYNTHESIS_TIMEOUT_MS = 90_000;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 4_096;

const fail = (code: string, summary: string, retryable: boolean, status = 200) =>
  Response.json({ ok: false, code, summary, retryable }, { status, headers: corsHeaders });

type ProviderCall = { url: string; headers: Record<string, string>; body: unknown };

/**
 * Each provider gets the same system prompt and the same sanitized digest. The
 * only thing that varies is the wire format — never what the model is allowed
 * to answer with.
 */
const buildCall = (
  model: ReasonModel,
  apiKey: string,
  system: string,
  user: string,
  maxTokens: number,
): ProviderCall => {
  if (model.provider === "anthropic") {
    return {
      url: ANTHROPIC,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: {
        model: model.providerModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      },
    };
  }

  return {
    url: GATEWAY,
    headers: {
      // The Lovable gateway authenticates on its own header, not Bearer.
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "fetch",
      "Content-Type": "application/json",
    },
    body: {
      model: model.providerModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    },
  };
};

const planCall = (
  model: ReasonModel,
  apiKey: string,
  digest: ReasonDigest,
  attachments: ServerEvidence[],
  retrieved: RetrievedConversation[] = [],
): ProviderCall =>
  buildCall(model, apiKey, SYSTEM_PROMPT, userPromptWithRecall(digest, attachments, retrieved), MAX_OUTPUT_TOKENS);

/**
 * The spoken reply, streamed.
 *
 * Words reach the person as the model produces them, so the conversation feels
 * alive instead of arriving in one silent lump. Both provider dialects are
 * normalized to one tiny event shape the browser understands, and a transport
 * failure ends the stream honestly rather than inventing a sentence.
 */
const streamReply = async (model: ReasonModel, apiKey: string, facts: unknown): Promise<Response> => {
  const call = buildCall(model, apiKey, REPLY_SYSTEM_PROMPT, replyUserPrompt(sanitizeReplyFacts(facts)), REPLY_MAX_OUTPUT_TOKENS);
  const body = { ...(call.body as Record<string, unknown>), stream: true };

  let upstream: Response;
  try {
    upstream = await fetch(call.url, { method: "POST", headers: call.headers, body: JSON.stringify(body) });
  } catch {
    return fail("reasoner_unavailable", "I couldn't reach my reasoning service just now.", true);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error(`agent-reason reply stream failed [${upstream.status}]: ${detail.slice(0, 300)}`);
    const code =
      upstream.status === 429 ? "rate_limited" : upstream.status === 402 ? "payment_required" : "reasoner_unavailable";
    return fail(code, "I couldn't put that into words just now.", upstream.status >= 500 || upstream.status === 429);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      const push = (text: string) => {
        if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
      };
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const raw of parts) {
            const trimmed = raw.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const event = JSON.parse(payload) as Record<string, unknown>;
              if (model.provider === "anthropic") {
                const delta = (event.delta ?? {}) as Record<string, unknown>;
                if (typeof delta.text === "string") push(delta.text);
              } else {
                const choices = Array.isArray(event.choices) ? event.choices : [];
                const first = (choices[0] ?? {}) as Record<string, unknown>;
                const delta = (first.delta ?? {}) as Record<string, unknown>;
                if (typeof delta.content === "string") push(delta.content);
              }
            } catch {
              // A malformed frame is skipped; the rest of the reply still lands.
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
    cancel(reason?: unknown) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};


const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you to be signed in before I can think about this project.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

/** One provider round-trip, with every transport failure mapped to a spoken reason. */
const askModel = async (
  model: ReasonModel,
  call: ProviderCall,
  timeoutMs: number,
): Promise<{ ok: true; content: string } | { ok: false; response: Response }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(call.url, {
      method: "POST",
      signal: controller.signal,
      headers: call.headers,
      body: JSON.stringify(call.body),
    });
  } catch {
    return { ok: false, response: fail("reasoner_unavailable", "I couldn't reach my reasoning service just now.", true) };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return {
      ok: false,
      response: fail("rate_limited", "I'm being rate limited right now — I'll fall back to my standard checks.", true),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      response: fail(
        "reasoner_unauthorized",
        model.provider === "anthropic"
          ? "My Anthropic key was rejected, so I'm using my standard checks."
          : "My reasoning service rejected its own credential.",
        false,
      ),
    };
  }
  if (response.status === 402) {
    return { ok: false, response: fail("payment_required", "My reasoning service needs credits topped up.", false) };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`agent-reason ${model.provider} failed [${response.status}]: ${detail.slice(0, 500)}`);
    return { ok: false, response: fail("reasoner_unavailable", "My reasoning service returned an error.", true) };
  }

  let content = "";
  try {
    content = readModelText(model.provider, await response.json());
  } catch {
    content = "";
  }
  return { ok: true, content };
};

/**
 * Meeting analysis. The transcript and the project history are both read
 * server-side from the authorized project; the browser supplies only the
 * source id. Everything the model returns is validated against the transcript
 * before a single row is written, and every row is written as a proposal.
 */
const analyzeMeetingSource = async (
  projectId: string,
  canonicalUrl: string | null,
  primaryDomain: string,
  sourceId: string,
  model: ReasonModel,
  apiKey: string,
): Promise<Response> => {
  if (!sourceId) return fail("invalid_input", "No transcript was named.", false);
  const service = serviceClient();

  const source = await service
    .from("project_sources")
    .select("id, project_id, title, occurred_at, normalized_text, processing_status, content_hash")
    .eq("id", sourceId)
    .eq("project_id", projectId)
    .maybeSingle();

  // Scoped by project on the query itself: a source id from another project
  // simply does not exist here.
  if (!source.data) return fail("source_not_found", "I couldn't find that transcript on this project.", false);

  const transcript = String(source.data.normalized_text ?? "");
  if (transcript.trim().length < 40) {
    return fail("invalid_input", "That transcript has no usable content.", false);
  }

  const chunks = chunkTranscript(transcript);
  const coverage = planTranscriptCoverage(chunks);
  if (coverage.exceedsBudget) {
    await service.from("project_sources").update({ processing_status: "failed" }).eq("id", sourceId);
    return fail(
      "transcript_too_large",
      "That meeting is longer than I can read in one pass, and I won't analyse only part of it.",
      false,
    );
  }

  const context = await loadProjectContext(projectId, canonicalUrl, transcript);
  const contextText = renderProjectContext(context);
  const meta = {
    title: String(source.data.title ?? "Client meeting"),
    occurredAt: source.data.occurred_at ? String(source.data.occurred_at) : "date not recorded",
  };
  const allowedHosts = [primaryDomain, canonicalUrl ?? ""]
    .filter(Boolean)
    .map((value) => value.replace(/^https?:\/\//, "").split("/")[0]);

  await service.from("project_sources").update({ processing_status: "analyzing" }).eq("id", sourceId);

  // A long meeting is read in windows. Provenance is always checked against the
  // whole transcript, so a window's quote keeps its true chunk index.
  const parts: Array<ReturnType<typeof mergeMeetingAnalyses>> = [];
  const dropped: string[] = [];
  for (const [index, window] of coverage.windows.entries()) {
    const prompt = meetingUserPrompt(context, window, meta, { index, total: coverage.windows.length });
    const asked = await askModel(
      model,
      buildCall(model, apiKey, MEETING_SYSTEM_PROMPT, prompt, MEETING_MAX_OUTPUT_TOKENS),
      MEETING_TIMEOUT_MS,
    );
    if (!asked.ok) {
      await service.from("project_sources").update({ processing_status: "failed" }).eq("id", sourceId);
      return asked.response;
    }

    const validated = validateMeetingAnalysis(parseModelJson(asked.content), { chunks, allowedHosts });
    if (!validated.ok) {
      // Half a meeting is worse than none: a partial plan reads as the whole plan.
      console.error(`agent-reason rejected meeting analysis part ${index}: ${validated.reason}`);
      await service.from("project_sources").update({ processing_status: "failed" }).eq("id", sourceId);
      return fail("analysis_rejected", "I read the meeting but couldn't turn it into something I trust yet.", true);
    }
    parts.push(validated.analysis);
    dropped.push(...validated.dropped);
  }

  const memoryIndex = await loadMemoryIndex(projectId);
  const analysis = mergeMeetingAnalyses(parts);

  // What the analysis was actually derived from, so a stored result can be
  // reproduced rather than merely trusted.
  const contextHash = await fingerprintAnalysisContext({
    contentHash: String(source.data.content_hash ?? ""),
    contextText,
    promptVersion: MEETING_PROMPT_VERSION,
    modelId: model.id,
    windowCount: coverage.windows.length,
  });

  // Re-analysis produces a new version rather than overwriting the record the
  // human may already have acted on.
  const previous = await service
    .from("source_analyses")
    .select("version")
    .eq("source_id", sourceId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = Number(previous.data?.version ?? 0) + 1;

  const analysisRow = await service
    .from("source_analyses")
    .insert({
      project_id: projectId,
      source_id: sourceId,
      version,
      mode: "analyze_meeting_source",
      model_id: model.id,
      prompt_version: MEETING_PROMPT_VERSION,
      status: "complete",
      result: analysis,
      context_hash: contextHash,
      window_count: coverage.windows.length,
      coverage: { chunks: chunks.length, windows: coverage.windows.length, mapReduce: coverage.mapReduce },
    })
    .select("id")
    .single();

  if (analysisRow.error || !analysisRow.data) {
    console.error(`agent-reason analysis write failed: ${analysisRow.error?.message ?? "unknown"}`);
    await service.from("project_sources").update({ processing_status: "failed" }).eq("id", sourceId);
    return fail("analysis_write_failed", "I read the meeting but couldn't file what I found.", true);
  }

  const analysisId = String(analysisRow.data.id);

  if (analysis.proposedTasks.length > 0) {
    // The same client ask comes up in three meetings. It becomes one run, not
    // three, and anything contradicting a standing decision is flagged for the
    // human rather than quietly proposed.
    const runRows = await service
      .from("runs")
      .select("id, title, task_summary, state")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(60);
    const existingWork: ExistingWork[] = (runRows.data ?? []).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      summary: String(row.task_summary ?? ""),
      open: !["complete", "failed", "rolled_back"].includes(String(row.state)),
    }));

    const memoryRows = await service
      .from("project_memory_entries")
      .select("id, title, content")
      .eq("project_id", projectId)
      .limit(200);
    const memoryFacts = (memoryRows.data ?? []).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      content: String(row.content ?? ""),
    }));

    await service.from("proposed_tasks").upsert(
      analysis.proposedTasks.map((task) => {
        const text = `${task.title} ${task.clientAsk} ${task.implementationApproach}`;
        const match = matchProposalToWork(text, existingWork);
        const conflict = detectMemoryConflict(text, memoryFacts);
        return {
        project_id: projectId,
        analysis_id: analysisId,
        source_id: sourceId,
        task_key: taskKeyFor(analysisId, task.title),
        title: task.title,
        client_ask: task.clientAsk,
        provenance: task.provenance,
        task_type: task.taskType,
        risk_level: task.riskLevel,
        needs_investigation: task.needsInvestigation,
        access_needed: task.accessNeeded,
        depends_on: task.dependsOn,
        implementation_approach: task.implementationApproach,
        verification_expectation: task.verificationExpectation,
        requires_execution_approval: task.requiresExecutionApproval,
        owner: task.owner,
        deadline_text: task.deadlineText,
        due_at: task.dueDate ? `${task.dueDate}T00:00:00.000Z` : null,
        duplicate_of_run_id: match.duplicateOfRunId,
        related_run_id: match.relatedRunId,
        conflict_note: [match.note, conflict].filter(Boolean).join(" "),
        original_proposal: task,
        status: "proposed",
        };
      }),
      { onConflict: "project_id,task_key" },
    );
  }

  if (analysis.memoryCandidates.length > 0) {
    // A hint is matched against real memory titles here, server-side. The model
    // never gets to name a memory row id.
    const resolveSupersedes = (hint: string): string | null => {
      const needle = hint.trim().toLowerCase();
      if (needle.length < 4) return null;
      const hit = memoryIndex.find((entry) => entry.title.toLowerCase().includes(needle));
      return hit ? hit.id : null;
    };

    await service.from("memory_candidates").upsert(
      analysis.memoryCandidates.map((candidate) => ({
        project_id: projectId,
        analysis_id: analysisId,
        source_id: sourceId,
        candidate_key: candidateKeyFor(analysisId, candidate.title),
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        memory_type: candidate.memoryType,
        importance: candidate.importance,
        supersedes_memory_id: resolveSupersedes(candidate.supersedesHint),
        provenance: candidate.provenance,
        status: "pending",
      })),
      { onConflict: "project_id,candidate_key" },
    );
  }

  await service.from("project_sources").update({ processing_status: "analyzed" }).eq("id", sourceId);

  return Response.json(
    {
      ok: true,
      model: model.id,
      sourceId,
      analysisId,
      version,
      contextHash,
      windows: coverage.windows.length,
      dropped,
      analysis,
    },
    { headers: corsHeaders },
  );
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("invalid_input", "Unsupported request.", false);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_input", "I couldn't read that request.", false);
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return fail("invalid_input", "No project was named.", false);

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) {
    return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before doing anything.", false);
  }

  const model = resolveReasonModel(body.model);
  const apiKey = Deno.env.get(model.secretName);
  if (!apiKey) {
    return fail(
      "reasoner_unavailable",
      model.provider === "anthropic"
        ? "My reasoning service needs an Anthropic key before I can use Claude."
        : "My reasoning service isn't configured yet.",
      false,
    );
  }

  const mode = typeof body.mode === "string" ? body.mode : "plan_next_agent_turn";
  if (
    mode !== "plan_next_agent_turn" &&
    mode !== "analyze_meeting_source" &&
    mode !== "compose_reply" &&
    mode !== "synthesize_diagnosis" &&
    mode !== "plan_fix" &&
    mode !== "monitor" &&
    mode !== "record_resolution"
  ) {
    return fail("invalid_input", "I don't know how to think about that.", false);
  }

  if (mode === "synthesize_diagnosis") {
    const digest: SynthesisDigest = sanitizeSynthesisDigest(body.digest);
    const asked = await askModel(
      model,
      buildCall(model, apiKey, SYNTHESIS_SYSTEM_PROMPT, synthesisUserPrompt(digest), SYNTHESIS_MAX_OUTPUT_TOKENS),
      SYNTHESIS_TIMEOUT_MS,
    );
    if (!asked.ok) return asked.response;

    const synthesis = asked.content.trim();
    // Output validation: non-empty, bounded length, no credential leakage.
    // A too-short answer read as a synthesis is worse than no synthesis.
    if (synthesis.length < 200 || synthesis.length > 8000) {
      console.error(
        `agent-reason rejected synthesis output: ${synthesis.length} chars`,
      );
      return fail(
        "synthesis_invalid",
        "I couldn't form a diagnosis I trust from this evidence yet.",
        true,
      );
    }

    return Response.json(
      { ok: true, mode, model: model.id, synthesis },
      { headers: corsHeaders },
    );
  }

  if (mode === "plan_fix") {
    // Fix-plan mode: takes evidence + diagnosis, returns ordered write steps.
    // Called by speakTurn after sufficient_evidence. Returns a FixPlan or null.
    const digest: FixDigest = sanitizeFixDigest(body.digest);
    const FIX_MAX_OUTPUT_TOKENS = 1500;
    const FIX_TIMEOUT_MS = 60_000;

    const asked = await askModel(
      model,
      buildCall(model, apiKey, FIX_PLAN_SYSTEM_PROMPT, fixPlanUserPrompt(digest), FIX_MAX_OUTPUT_TOKENS),
      FIX_TIMEOUT_MS,
    );
    if (!asked.ok) return asked.response;

    const fix_plan = parseFixPlan(asked.content);
    if (!fix_plan) {
      // Model couldn't produce a valid plan — not a hard error, just no plan.
      return Response.json(
        { ok: true, mode, model: model.id, fix_plan: null, reason: "no_actionable_fix" },
        { headers: corsHeaders },
      );
    }

    return Response.json(
      { ok: true, mode, model: model.id, fix_plan },
      { headers: corsHeaders },
    );
  }

  if (mode === "monitor") {
    // Autonomous health-check mode. Called by agent-monitor on a schedule.
    // Returns { ok, monitor_result: { severity, title, summary, findings, recommended_fix, auto_fixable } }.
    const monitorPrompt = typeof body.monitor_prompt === "string"
      ? body.monitor_prompt.slice(0, 2000)
      : "Perform a rapid WordPress health check and return a JSON object with severity, title, summary, findings, recommended_fix, and auto_fixable fields.";
    const domain = typeof body.domain === "string" ? body.domain.slice(0, 200) : authz.project.primaryDomain ?? "";

    const MONITOR_SYSTEM = `You are an autonomous WordPress site health monitor. You check a WordPress site and return a structured JSON health report. Be concise, factual, and conservative — only flag real issues you can verify from the data available. Never fabricate findings.`;
    const monitorUser = `${monitorPrompt}\n\nSite domain: ${domain}\n\nReturn ONLY valid JSON matching the schema. No explanation outside the JSON object.`;

    const asked = await askModel(
      model,
      buildCall(model, apiKey, MONITOR_SYSTEM, monitorUser, 1200),
      60_000,
    );
    if (!asked.ok) return asked.response;

    let monitor_result: Record<string, unknown> = {
      severity: "none",
      title: "Health check complete",
      summary: "No issues detected.",
      findings: [],
      recommended_fix: null,
      auto_fixable: false,
    };
    try {
      const raw = asked.content.trim().replace(/^```json\s*/i, "").replace(/```$/m, "").trim();
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        monitor_result = {
          severity: ["none", "low", "medium", "high"].includes(String(parsed.severity)) ? String(parsed.severity) : "none",
          title: String(parsed.title ?? "Health check").slice(0, 200),
          summary: String(parsed.summary ?? "").slice(0, 1000),
          findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 10).map(String) : [],
          recommended_fix: parsed.recommended_fix ? String(parsed.recommended_fix).slice(0, 500) : null,
          auto_fixable: parsed.auto_fixable === true,
        };
      }
    } catch {
      // JSON parse failed — return the safe default (severity=none, no alert).
      console.warn("agent-reason monitor: failed to parse model JSON");
    }

    return Response.json({ ok: true, mode, model: model.id, monitor_result }, { headers: corsHeaders });
  }

  if (mode === "compose_reply") {
    return await streamReply(model, apiKey, body.facts);
  }

  // ---------------------------------------------------------------------------
  // record_resolution: called when a run reaches "complete" with a confirmed fix.
  // Extracts the fix pattern from the run's findings + actions and upserts it
  // into knowledge_base_entries so future runs benefit from it.
  // ---------------------------------------------------------------------------
  if (mode === "record_resolution") {
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const taskType = typeof body.taskType === "string" ? body.taskType.trim().slice(0, 40) : "";
    const taskTitle = typeof body.taskTitle === "string" ? body.taskTitle.trim().slice(0, 160) : "";
    const hostContext = typeof body.hostContext === "string" ? body.hostContext.trim().slice(0, 40) : null;

    if (!runId || !taskType || !taskTitle) {
      return Response.json({ ok: true, recorded: false, reason: "insufficient_context" }, { headers: corsHeaders });
    }

    // Verify this run belongs to the authorized project.
    if (!(await runBelongsToProject(authz.project.projectId, runId))) {
      return fail("not_found", "I can't find that task on this project.", false);
    }

    // Load findings and successful actions for this run.
    const [findingsResult, actionsResult] = await Promise.all([
      service.from("run_findings").select("title, summary, severity").eq("run_id", runId).limit(10),
      service.from("run_actions").select("summary, outcome").eq("run_id", runId).eq("outcome", "success").limit(10),
    ]);

    const findings = (findingsResult.data ?? []) as Array<{ title: string; summary: string; severity: string }>;
    const actions = (actionsResult.data ?? []) as Array<{ summary: string; outcome: string }>;

    // Need at least one finding (the diagnosis) to be worth recording.
    if (findings.length === 0) {
      return Response.json({ ok: true, recorded: false, reason: "no_findings" }, { headers: corsHeaders });
    }

    // Build a symptom pattern from the task title + top finding title.
    const topFinding = findings[0];
    const symptomPattern = taskTitle.slice(0, 200);
    const evidenceSignals = findings.map((f) => f.title.slice(0, 100)).slice(0, 5);
    const resolutionParts = actions.map((a) => a.summary.slice(0, 200));
    const resolution = resolutionParts.length > 0
      ? resolutionParts.join(" Then: ")
      : topFinding.summary.slice(0, 600);

    // Upsert: if an identical symptom_pattern + task_type already exists,
    // increment project_count and update last_confirmed_at. Otherwise insert.
    const existing = await service
      .from("knowledge_base_entries")
      .select("id, project_count")
      .eq("scope", "wordpress")
      .eq("task_type", taskType)
      .eq("symptom_pattern", symptomPattern)
      .maybeSingle();

    const now = new Date().toISOString();
    if (existing.data) {
      await service
        .from("knowledge_base_entries")
        .update({
          resolution: resolution.slice(0, 600),
          evidence_signals: JSON.stringify(evidenceSignals),
          host_context: hostContext,
          project_count: (existing.data.project_count ?? 1) + 1,
          last_confirmed_at: now,
          updated_at: now,
        })
        .eq("id", existing.data.id);
      return Response.json({ ok: true, recorded: true, action: "updated", id: existing.data.id }, { headers: corsHeaders });
    }

    const { data: inserted } = await service
      .from("knowledge_base_entries")
      .insert({
        scope: "wordpress",
        task_type: taskType,
        symptom_pattern: symptomPattern,
        resolution: resolution.slice(0, 600),
        evidence_signals: JSON.stringify(evidenceSignals),
        tools_used: JSON.stringify([]),
        host_context: hostContext,
        project_count: 1,
        last_confirmed_at: now,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .maybeSingle();

    return Response.json({ ok: true, recorded: true, action: "inserted", id: inserted?.id ?? null }, { headers: corsHeaders });
  }

  if (mode === "analyze_meeting_source") {
    return await analyzeMeetingSource(
      authz.project.projectId,
      authz.project.canonicalUrl,
      authz.project.primaryDomain,
      typeof body.sourceId === "string" ? body.sourceId : "",
      model,
      apiKey,
    );
  }

  const digest = sanitizeDigest(body.digest);

  // First-class attachment evidence, loaded server-side and scoped to the run
  // the browser says is active — after proving that run is this project's.
  const runClaim = typeof body.runId === "string" ? body.runId : "";
  let attachments: ServerEvidence[] = [];
  if (runClaim) {
    if (!(await runBelongsToProject(authz.project.projectId, runClaim))) {
      return fail("not_found", "I can't find that task on this project.", false);
    }
    attachments = await loadRunEvidence(authz.project.projectId, runClaim).catch(() => []);
  }

  // Long-term recall: what the person was proven to be referring back to on
  // this task. Written by the continuity boundary, never by the browser.
  const retrieved = await loadRetrievedConversation(authz.project.projectId, runClaim || null).catch(() => []);

  // Knowledge base: fetch the top matching diagnostic patterns for this task
  // type and inject them as priorIncidents so the model reasons from proven
  // fix patterns rather than starting from scratch every time.
  // Resolve hosting provider for this project's environment — used to boost
  // host-specific KB patterns (e.g. Kinsta CDN artifacts on Kinsta projects).
  let hostingProvider: string | null = null;
  try {
    if (authz.project.environmentId) {
      const envRow = await service
        .from("project_environments")
        .select("hosting_provider")
        .eq("id", authz.project.environmentId)
        .maybeSingle();
      hostingProvider = envRow.data?.hosting_provider ?? null;
    }
  } catch { /* non-fatal */ }

  const kbPatterns = await loadKnowledgeBasePatterns(
    service,
    digest.taskType,
    hostingProvider,
  ).catch(() => []);
  if (kbPatterns.length > 0) {
    digest.priorIncidents = [
      ...kbPatterns,
      ...digest.priorIncidents,
    ].slice(0, 5);
  }

  const asked = await askModel(model, planCall(model, apiKey, digest, attachments, retrieved), TIMEOUT_MS);
  if (!asked.ok) return asked.response;

  const validated = validateReasonPlan(parseModelJson(asked.content), digest.capabilities);
  if (!validated.ok) {
    console.error(`agent-reason rejected model plan: ${validated.reason}`);
    return fail("plan_rejected", "I couldn't form a safe next step, so I'm using my standard checks.", false);
  }

  return Response.json({ ok: true, model: model.id, plan: validated.plan }, { headers: corsHeaders });
});