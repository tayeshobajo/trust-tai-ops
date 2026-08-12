// Trust Tai Ops — conversation continuity boundary.
//
// Two jobs, both server-authoritative:
//   index   — after a message is stored, record any labelled choices it offered
//   resolve — decide what a backward reference ("option B", "same as
//             yesterday") actually points at, or refuse to guess
//
// The browser supplies only ids. Every piece of text that influences the answer
// is re-read from the database after project authorization, so a tampered
// client cannot manufacture history for the agent to act on.
//
// Nothing on this path executes anything against a customer system.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import { isUuid } from "../_shared/evidencePolicy.ts";
import { extractAnchors } from "../_shared/continuity/anchors.ts";
import {
  type AnchorRecord,
  type AnchorQuery,
  type ContinuityStore,
  type MessageRecord,
  SEARCH_LIMIT,
  resolveContinuity,
  whenLabel,
} from "../_shared/continuity/retrieval.ts";

const RECENT_MESSAGE_WINDOW = 400;
/** How far back a one-off legacy backfill will read agent messages. */
const BACKFILL_WINDOW = 500;
const ANCHOR_COLUMNS =
  "id, run_id, source_message_id, anchor_type, label, normalized_label, aliases, summary, created_at";

const fail = (code: string, summary: string, retryable: boolean, status = 200) =>
  new Response(JSON.stringify({ ok: false, code, summary, retryable }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ok = (payload: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: true, ...payload }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you signed in before I can read this project's history.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

type MessageRow = { id: string; run_id: string | null; role: string; body: unknown; created_at: string };

const textOf = (body: unknown): string => (Array.isArray(body) ? body.join(" ") : String(body ?? ""));

const runTitles = async (projectId: string): Promise<Map<string, string>> => {
  const { data } = await serviceClient().from("runs").select("id, title").eq("project_id", projectId).limit(200);
  return new Map((data ?? []).map((row) => [String(row.id), String(row.title ?? "")]));
};

/**
 * The store the pure resolver runs against. Project scoping is applied here,
 * once, so no ranking path can reach another customer's conversation.
 */
const toAnchor = (row: Record<string, unknown>, titles: Map<string, string>): AnchorRecord => ({
  id: String(row.id),
  runId: row.run_id ? String(row.run_id) : null,
  sourceMessageId: String(row.source_message_id),
  anchorType: String(row.anchor_type),
  label: String(row.label ?? ""),
  normalizedLabel: String(row.normalized_label ?? ""),
  aliases: Array.isArray(row.aliases) ? row.aliases.map((alias) => String(alias)) : [],
  summary: String(row.summary ?? ""),
  createdAt: String(row.created_at),
  runTitle: row.run_id ? titles.get(String(row.run_id)) ?? null : null,
});

/**
 * Anchors matching what the person named, filtered in the database.
 *
 * Narrowing here rather than in memory is what makes a months-old choice
 * survive a busy project: a recency window would quietly drop it and the agent
 * would answer "I can't find that" about something it really did offer.
 */
const queryAnchors = async (projectId: string, query: AnchorQuery, titles: Map<string, string>) => {
  let request = serviceClient().from("conversation_anchors").select(ANCHOR_COLUMNS).eq("project_id", projectId);
  if (query.normalizedLabel) request = request.eq("normalized_label", query.normalizedLabel);
  else if (query.alias) request = request.contains("aliases", [query.alias]);
  const { data } = await request.order("created_at", { ascending: false }).limit(200);
  return (data ?? []).map((row) => toAnchor(row as Record<string, unknown>, titles));
};

/**
 * Conversations that predate anchoring still contain real, structured offers.
 * Rather than refuse to remember them forever, historical *agent* messages are
 * re-read through the same conservative parser the live path uses, and only an
 * unmistakable labelled option list mints anything. User text is never a
 * source: nobody may author the choice the agent is later held to.
 *
 * Runs only when a named lookup found nothing, and is idempotent.
 */
const backfillLegacyAnchors = async (projectId: string): Promise<number> => {
  const service = serviceClient();
  const { data } = await service
    .from("project_messages")
    .select("id, run_id, role, body, created_at")
    .eq("project_id", projectId)
    .in("role", ["agent", "system"])
    .order("created_at", { ascending: false })
    .limit(BACKFILL_WINDOW);

  const rows = (data ?? []) as MessageRow[];
  if (rows.length === 0) return 0;

  const { data: existing } = await service
    .from("conversation_anchors")
    .select("source_message_id")
    .eq("project_id", projectId)
    .in("source_message_id", rows.map((row) => String(row.id)));
  const indexed = new Set((existing ?? []).map((row) => String(row.source_message_id)));

  const inserts = rows
    .filter((row) => !indexed.has(String(row.id)))
    .flatMap((row) =>
      extractAnchors({
        id: String(row.id),
        runId: row.run_id ? String(row.run_id) : null,
        role: String(row.role),
        body: Array.isArray(row.body) ? row.body.map((line) => String(line)) : [String(row.body ?? "")],
        createdAt: String(row.created_at),
      }).map((draft) => ({
        project_id: projectId,
        run_id: row.run_id,
        source_message_id: row.id,
        anchor_type: draft.anchorType,
        label: draft.label,
        normalized_label: draft.normalizedLabel,
        aliases: draft.aliases,
        summary: draft.summary,
        ordinal: draft.ordinal,
      })),
    );

  if (inserts.length === 0) return 0;
  await service
    .from("conversation_anchors")
    .upsert(inserts, { onConflict: "source_message_id,normalized_label", ignoreDuplicates: true });
  return inserts.length;
};

const continuityStore = (titles: Map<string, string>): ContinuityStore => ({
  listAnchors: async (projectId, query) => {
    const named = Boolean(query.normalizedLabel || query.alias);
    const first = await queryAnchors(projectId, query, titles);
    if (first.length > 0 || !named) return first;
    // Nothing named found: the project may simply predate anchoring.
    const minted = await backfillLegacyAnchors(projectId).catch(() => 0);
    return minted > 0 ? await queryAnchors(projectId, query, titles) : first;
  },
  searchMessages: async (projectId, terms, limit) => {
    if (terms.length === 0) return [];
    // A bounded, newest-first window keeps recall cheap and predictable; the
    // lexical filter itself runs in memory so scoring stays inspectable.
    const { data } = await serviceClient()
      .from("project_messages")
      .select("id, run_id, role, body, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGE_WINDOW);

    const rows = (data ?? []) as MessageRow[];
    const matched: MessageRecord[] = [];
    for (const row of rows) {
      const text = textOf(row.body);
      const haystack = text.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) continue;
      matched.push({
        id: String(row.id),
        runId: row.run_id ? String(row.run_id) : null,
        role: String(row.role),
        text,
        createdAt: String(row.created_at),
        runTitle: row.run_id ? titles.get(String(row.run_id)) ?? null : null,
      });
      if (matched.length >= limit) break;
    }
    return matched;
  },
});

const loadMessage = async (projectId: string, messageId: string): Promise<MessageRow | null> => {
  const { data } = await serviceClient()
    .from("project_messages")
    .select("id, run_id, role, body, created_at")
    .eq("project_id", projectId)
    .eq("id", messageId)
    .maybeSingle();
  return (data as MessageRow | null) ?? null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", "That request isn't supported here.", false, 405);
  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("bad_request", "I couldn't read that request.", false, 400);
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const messageId = typeof body.messageId === "string" ? body.messageId : "";
  const mode = body.mode === "index" ? "index" : "resolve";
  if (!isUuid(projectId) || !isUuid(messageId)) {
    return fail("bad_request", "I couldn't tell which conversation that belongs to.", false, 400);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) {
    return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before doing anything.", false);
  }

  // Cross-project safety: the message must live in the authorized project.
  const message = await loadMessage(projectId, messageId);
  if (!message) return fail("not_found", "I can't find that message on this project.", false);

  const service = serviceClient();
  const titles = await runTitles(projectId).catch(() => new Map<string, string>());

  if (mode === "index") {
    const drafts = extractAnchors({
      id: String(message.id),
      runId: message.run_id ? String(message.run_id) : null,
      role: String(message.role),
      body: Array.isArray(message.body) ? message.body.map((line) => String(line)) : [String(message.body ?? "")],
      createdAt: String(message.created_at),
    });
    if (drafts.length === 0) return ok({ anchors: 0 });

    // Re-indexing the same message must not multiply its anchors.
    const { error } = await service.from("conversation_anchors").upsert(
      drafts.map((draft) => ({
        project_id: projectId,
        run_id: message.run_id,
        source_message_id: message.id,
        anchor_type: draft.anchorType,
        label: draft.label,
        normalized_label: draft.normalizedLabel,
        aliases: draft.aliases,
        summary: draft.summary,
        ordinal: draft.ordinal,
      })),
      { onConflict: "source_message_id,normalized_label", ignoreDuplicates: true },
    );
    if (error) return fail("index_failed", "I couldn't record that choice for later.", true);
    return ok({ anchors: drafts.length });
  }

  const now = Date.now();
  const result = await resolveContinuity(
    {
      projectId,
      runId: message.run_id ? String(message.run_id) : null,
      text: textOf(message.body),
      now,
    },
    continuityStore(titles),
  );

  // Only a confident resolution becomes provenance. An ambiguous or missing
  // match is a question, and a question must never leave a record claiming the
  // person meant something.
  if (result.status === "resolved" && result.references.length > 0) {
    await service.from("message_references").upsert(
      result.references.map((reference) => ({
        project_id: projectId,
        message_id: message.id,
        run_id: message.run_id,
        anchor_id: reference.anchorId,
        source_message_id: reference.sourceMessageId,
        source_run_id: reference.sourceRunId,
        resolution_method: reference.method,
        confidence: reference.confidence,
        label: reference.label ?? "",
        summary: reference.summary,
      })),
      { onConflict: "message_id,source_message_id", ignoreDuplicates: true },
    );
  }

  return ok({
    status: result.status,
    question: result.question,
    references: result.references.map((reference) => ({
      label: reference.label,
      summary: reference.summary,
      when: whenLabel(reference.createdAt, now),
      method: reference.method,
      confidence: Number(reference.confidence.toFixed(2)),
      sourceRunId: reference.sourceRunId,
    })),
  });
});

export const CONTINUITY_SEARCH_LIMIT = SEARCH_LIMIT;