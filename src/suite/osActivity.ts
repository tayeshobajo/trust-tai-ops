/**
 * Ops -> Trust Tai OS signal sync.
 *
 * Only business-level Ops events cross the boundary. Shell commands, raw
 * logs, credentials, and technical chatter stay inside Ops. Writes go to the
 * OS `public.activities` table using the OS publishable key plus the current
 * OS user's bearer token, so OS row-level security remains the boundary.
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
};

export type SuiteActivityRow = {
  activity_type: OpsSuiteEvent;
  summary: string;
  project_id: string | null;
  metadata: Record<string, unknown>;
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

export function buildSuiteActivity(signal: OpsSuiteSignal, opsBaseUrl: string): SuiteActivityRow {
  const metadata: Record<string, unknown> = {
    source_app: "ops",
    ops_project_id: signal.opsProjectId,
    canonical_project_id: signal.canonicalProjectId,
    ops_run_id: signal.opsRunId ?? null,
    ops_event_key: signal.opsEventKey,
    dedupe_key: suiteDedupeKey(signal),
    evidence_ref: signal.evidenceRef ?? null,
    evidence_summary: signal.evidenceSummary ? sanitizeSummary(signal.evidenceSummary) : null,
    destination_route: destinationRoute(signal, opsBaseUrl),
  };

  return {
    activity_type: signal.event,
    summary: sanitizeSummary(signal.summary),
    project_id: signal.canonicalProjectId,
    metadata,
  };
}

export type SuiteSyncResult =
  | { status: "unavailable"; reason: "not_linked" | "no_os_session" | "not_configured" }
  | { status: "rejected"; reason: "secret_material" | "unknown_event" }
  | { status: "duplicate" }
  | { status: "written" }
  | { status: "failed"; reason: string };

export type SuiteSyncDeps = {
  /** Returns an existing activity id for this dedupe key, or null. */
  findExisting: (dedupeKey: string) => Promise<string | null>;
  insert: (row: SuiteActivityRow) => Promise<void>;
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
  if (!signal.canonicalProjectId) return { status: "unavailable", reason: "not_linked" };

  const row = buildSuiteActivity(signal, opsBaseUrl);

  if (containsSecretMaterial(row)) {
    return { status: "rejected", reason: "secret_material" };
  }

  try {
    const dedupeKey = suiteDedupeKey(signal);
    const existing = await deps.findExisting(dedupeKey);
    if (existing) return { status: "duplicate" };

    await deps.insert(row);
    return { status: "written" };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "sync_failed" };
  }
}