/**
 * Ops -> Trust Tai OS signal sync.
 *
 * Only business-level Ops events cross the boundary. Shell commands, raw
 * logs, credentials, and technical chatter stay inside Ops. Writes go to the
 * OS `public.activities` table using the OS publishable key plus the current
 * OS user's bearer token, so OS row-level security remains the boundary.
 *
 * The row shape below is the live OS contract, not an Ops invention:
 *   id, organization_id (uuid, required), event_type (text, required),
 *   actor_user_id, app_key (text, required), entity_type, entity_id,
 *   summary, payload (jsonb, required), provenance (jsonb, required),
 *   occurred_at (timestamptz, required), created_at.
 * There is no `activity_type`, no `project_id`, and no `metadata` column.
 */

export const OPS_SUITE_EVENTS = [
  "ops.issue_detected",
  "ops.run_started",
  "ops.blocked",
  "ops.approval_required",
  "ops.fix_applied",
  "ops.qa_failed",
  "ops.qa_passed",
  "ops.rollback_performed",
  "ops.recommendation_created",
  "ops.completed",
] as const;

export type OpsSuiteEvent = (typeof OPS_SUITE_EVENTS)[number];

/** The app_key every Ops-authored activity carries in the OS. */
export const OPS_APP_KEY = "ops";

export type OpsSuiteSignal = {
  event: OpsSuiteEvent;
  opsProjectId: string;
  canonicalProjectId: string | null;
  opsRunId?: string | null;
  /** Stable Ops-side identity for this event. Drives idempotency. */
  opsEventKey: string;
  summary: string;
  evidenceRef?: string | null;
  evidenceSummary?: string | null;
  /**
   * When the Ops event actually happened. Defaulted at emission time only —
   * a historical time is never invented for an event whose time is unknown.
   */
  occurredAt?: string | null;
};

/**
 * Who is writing, and into which OS organization. The organization id comes
 * from the OS handoff and is never treated as an authorization decision: OS
 * row-level security is the boundary that accepts or rejects the write.
 */
export type SuiteWriteContext = {
  organizationId: string;
  actorUserId?: string | null;
};

export type SuiteActivityRow = {
  organization_id: string;
  event_type: OpsSuiteEvent;
  actor_user_id: string | null;
  app_key: typeof OPS_APP_KEY;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  occurred_at: string;
};

/**
 * Field names and value shapes that must never leave Ops. Checked against the
 * whole serialized payload, not just top-level keys.
 */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|private_key|privatekey|api_key|apikey|access_token|refresh_token|service_role|ciphertext|cipher_text|sealed|credential_value|nonce|session_cookie)/i;

const SECRET_VALUE_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|sb_secret_|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+)/;

export function containsSecretMaterial(value: unknown): boolean {
  const seen = new Set<unknown>();

  const walk = (node: unknown): boolean => {
    if (typeof node === "string") return SECRET_VALUE_PATTERN.test(node);
    if (!node || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);

    if (Array.isArray(node)) return node.some(walk);

    return Object.entries(node as Record<string, unknown>).some(([key, child]) => {
      if (SECRET_KEY_PATTERN.test(key)) return true;
      return walk(child);
    });
  };

  return walk(value);
}

/** Strips anything that looks like credential material out of prose. */
export function sanitizeSummary(text: string): string {
  return text
    // Unterminated key blocks are stripped too: a pasted fragment is still a key.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[removed]")
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, "[removed]")
    .replace(/\bsb_secret_[A-Za-z0-9_-]+/g, "[removed]")
    .replace(/\b(password|passwd|secret|token|api[_ ]?key)\b\s*[:=]\s*\S+/gi, "$1: [removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** A stable key so a retry of the same Ops event never creates a second row. */
export function suiteDedupeKey(signal: Pick<OpsSuiteSignal, "event" | "opsProjectId" | "opsEventKey">): string {
  return `ops:${signal.opsProjectId}:${signal.event}:${signal.opsEventKey}`;
}

/** Where the OS should send someone who clicks through to Ops. */
export function destinationRoute(signal: OpsSuiteSignal, opsBaseUrl: string): string {
  const base = opsBaseUrl.replace(/\/+$/, "");
  const runPart = signal.opsRunId ? `?run=${encodeURIComponent(signal.opsRunId)}` : "";
  return `${base}/project/${encodeURIComponent(signal.opsProjectId)}${runPart}`;
}

export function buildSuiteActivity(
  signal: OpsSuiteSignal,
  opsBaseUrl: string,
  context: SuiteWriteContext,
): SuiteActivityRow {
  // Safe structured detail about the Ops event. No logs, no command output.
  const payload: Record<string, unknown> = {
    ops_project_id: signal.opsProjectId,
    canonical_project_id: signal.canonicalProjectId,
    ops_run_id: signal.opsRunId ?? null,
    evidence_ref: signal.evidenceRef ?? null,
    evidence_summary: signal.evidenceSummary ? sanitizeSummary(signal.evidenceSummary) : null,
    destination_route: destinationRoute(signal, opsBaseUrl),
  };

  const provenance: Record<string, unknown> = {
    source_app: OPS_APP_KEY,
    source: "trust-tai-ops",
    ops_event_key: signal.opsEventKey,
    dedupe_key: suiteDedupeKey(signal),
    ops_project_id: signal.opsProjectId,
  };

  return {
    organization_id: context.organizationId,
    event_type: signal.event,
    // An unknown actor is left null so OS RLS decides, rather than Ops
    // asserting an identity it cannot prove.
    actor_user_id: context.actorUserId && context.actorUserId.length > 0 ? context.actorUserId : null,
    app_key: OPS_APP_KEY,
    entity_type: signal.canonicalProjectId ? "project" : null,
    entity_id: signal.canonicalProjectId,
    summary: sanitizeSummary(signal.summary),
    payload,
    provenance,
    occurred_at: signal.occurredAt ?? new Date().toISOString(),
  };
}

export type SuiteSyncResult =
  | { status: "unavailable"; reason: "not_linked" | "no_os_session" | "no_organization" | "not_configured" }
  | { status: "rejected"; reason: "secret_material" | "unknown_event" }
  | { status: "duplicate" }
  | { status: "written" }
  | { status: "failed"; reason: string };

export type SuiteSyncDeps = {
  /** Returns an existing activity id for this dedupe key, or null. */
  findExisting: (dedupeKey: string) => Promise<string | null>;
  /**
   * Read-before-write alone is race-prone. Once the OS adds a unique index on
   * the provenance dedupe key, a 409 unique violation is the authoritative
   * duplicate answer, so the writer reports it rather than throwing.
   */
  insert: (row: SuiteActivityRow) => Promise<"written" | "duplicate">;
  /** The OS organization and actor this browser session may write as. */
  context: SuiteWriteContext;
};

/**
 * Idempotent, fail-quiet sync. A missing OS session or a missing canonical
 * link is never an error: Ops keeps working and simply reports that suite
 * sync is unavailable.
 */
export async function syncSuiteSignal(
  signal: OpsSuiteSignal,
  deps: SuiteSyncDeps | null,
  opsBaseUrl: string,
): Promise<SuiteSyncResult> {
  if (!OPS_SUITE_EVENTS.includes(signal.event)) {
    return { status: "rejected", reason: "unknown_event" };
  }
  if (!deps) return { status: "unavailable", reason: "no_os_session" };
  if (!deps.context?.organizationId) return { status: "unavailable", reason: "no_organization" };
  if (!signal.canonicalProjectId) return { status: "unavailable", reason: "not_linked" };

  const row = buildSuiteActivity(signal, opsBaseUrl, deps.context);

  if (containsSecretMaterial(row)) {
    return { status: "rejected", reason: "secret_material" };
  }

  try {
    const dedupeKey = suiteDedupeKey(signal);
    const existing = await deps.findExisting(dedupeKey);
    if (existing) return { status: "duplicate" };

    const outcome = await deps.insert(row);
    return outcome === "duplicate" ? { status: "duplicate" } : { status: "written" };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "sync_failed" };
  }
}