// Trust Tai Ops — server-side reasoning boundary.
//
// The browser never talks to a model and never holds a model credential. This
// function proves the caller belongs to the project, asks a model a question,
// and returns only answers that survive validation.
//
// Two modes share the boundary:
//   plan_next_agent_turn   — the next read-only inspection, from a closed catalog.
//   analyze_meeting_source — what a client meeting means for this project.
//
// Nothing here executes a tool, approves anything, or mutates WordPress.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import {
  loadMemoryIndex,
  loadProjectContext,
  loadRetrievedConversation,
  loadRunEvidence,
  runBelongsToProject,
} from "../_shared/contextLoader.ts";
import { validateReasonPlan } from "../_shared/reasonCatalog.ts";
import { readModelText, resolveReasonModel, type ReasonModel } from "../_shared/reasonModels.ts";
import {
  SYSTEM_PROMPT,
  parseModelJson,
  sanitizeDigest,
  userPromptWithRecall,
  type RetrievedConversation,
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
  if (mode !== "plan_next_agent_turn" && mode !== "analyze_meeting_source") {
    return fail("invalid_input", "I don't know how to think about that.", false);
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

  const asked = await askModel(model, planCall(model, apiKey, digest, attachments, retrieved), TIMEOUT_MS);
  if (!asked.ok) return asked.response;

  const validated = validateReasonPlan(parseModelJson(asked.content), digest.capabilities);
  if (!validated.ok) {
    console.error(`agent-reason rejected model plan: ${validated.reason}`);
    return fail("plan_rejected", "I couldn't form a safe next step, so I'm using my standard checks.", false);
  }

  return Response.json({ ok: true, model: model.id, plan: validated.plan }, { headers: corsHeaders });
});