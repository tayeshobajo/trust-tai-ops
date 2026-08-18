/**
 * Runtime wiring for the suite integration: the SSO exchange call, the
 * canonical project link write, and the OS activity sync deps.
 *
 * The OS access token lives only in the module-scoped session holder. It is
 * never written to localStorage and never appears in a URL.
 */

import { isSuiteConfigured, resolveOpsEnv } from "../env";
import { getSupabaseClient } from "../supabase";
import { clearSuiteSession, getSuiteSession, setSuiteSession } from "./osToken";
import { OPS_APP_KEY, syncSuiteSignal } from "./osActivity";
import type { OpsSuiteSignal, SuiteActivityRow, SuiteSyncDeps, SuiteSyncResult } from "./osActivity";
import {
  OPS_PROJECTION_CONFLICT_TARGET,
  OPS_PROJECTION_TABLE,
  buildProjectionBatch,
  syncProjectionRows,
} from "./projection";
import type { OpsProjectProjectionRow, ProjectionSyncDeps, ProjectionSyncResult } from "./projection";
import type { SsoHandoff } from "./ssoBridge";
import type { Project } from "../types";

export type SsoExchangeResult =
  | { ok: true; email: string; role: string; canonicalProjectId: string | null }
  | { ok: false; error: string };

/**
 * Exchanges a verified-by-the-server OS token for a local Ops session.
 * The OS token is passed once, over HTTPS, in a request body — never a URL.
 */
export async function exchangeOsHandoff(handoff: SsoHandoff): Promise<SsoExchangeResult> {
  const client = getSupabaseClient();

  try {
    const { data, error } = await client.functions.invoke("os-sso-exchange", {
      body: {
        osAccessToken: handoff.accessToken,
        // Sent for context only. The function still verifies the token
        // against the OS auth service; the organization id never substitutes
        // for that verification.
        osOrganizationId: handoff.organizationId,
        canonicalProjectId: handoff.canonicalProjectId,
      },
    });

    if (error) return { ok: false, error: "sso_exchange_failed" };

    const payload = data as {
      ok?: boolean;
      error?: string;
      email?: string;
      tokenHash?: string;
      role?: string;
      osUserId?: string;
      canonicalProjectId?: string | null;
    };

    if (!payload?.ok || !payload.tokenHash || !payload.email) {
      return { ok: false, error: payload?.error ?? "sso_exchange_failed" };
    }

    // Normal Supabase client verification. The local session is created by the
    // SDK, not handed over as a raw credential.
    const verified = await client.auth.verifyOtp({ type: "email", token_hash: payload.tokenHash });
    if (verified.error) return { ok: false, error: "local_session_failed" };

    // Held for this browser session only, so signals can be written back to
    // the OS under the current OS user's own RLS.
    setSuiteSession({
      osAccessToken: handoff.accessToken,
      osUserId: payload.osUserId ?? "",
      osEmail: payload.email,
      osOrganizationId: handoff.organizationId,
      canonicalProjectId: payload.canonicalProjectId ?? handoff.canonicalProjectId,
      expiresAt: 0,
    });

    return {
      ok: true,
      email: payload.email,
      role: payload.role ?? "viewer",
      canonicalProjectId: payload.canonicalProjectId ?? handoff.canonicalProjectId,
    };
  } catch {
    return { ok: false, error: "sso_exchange_failed" };
  } finally {
    // Drop the caller's copy as soon as the exchange is done.
    handoff.accessToken = "";
  }
}

/** Persists the canonical link after a deterministic decision or an explicit human choice. */
export async function persistCanonicalLink(opsProjectId: string, canonicalProjectId: string): Promise<boolean> {
  try {
    const client = getSupabaseClient();
    const { error } = await client
      .from("projects")
      .update({ trust_tai_os_project_id: canonicalProjectId } as never)
      .eq("id", opsProjectId);
    return !error;
  } catch {
    return false;
  }
}

const OS_REST_HEADERS = (token: string, anonKey: string) => ({
  apikey: anonKey,
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

/**
 * Dedupe against the OS activities table. The live schema now has a top-level
 * `source_event_key` with a unique partial index on
 * (organization_id, app_key, source_event_key), so the read below is a cheap
 * fast path and the 409 handled in `insert` is the authoritative, race-safe
 * answer.
 */
function suiteDeps(): SuiteSyncDeps | null {
  const env = resolveOpsEnv();
  const session = getSuiteSession();
  if (!session || !isSuiteConfigured(env)) return null;

  const base = `${(env.osSupabaseUrl ?? "").replace(/\/+$/, "")}/rest/v1/activities`;
  const headers = OS_REST_HEADERS(session.osAccessToken, env.osSupabasePublicKey ?? "");

  return {
    context: { organizationId: session.osOrganizationId, actorUserId: session.osUserId },
    findExisting: async (dedupeKey: string) => {
      // Top-level indexed column; provenance.dedupe_key is kept only for
      // traceability and older rows.
      const filter = `source_event_key=eq.${encodeURIComponent(dedupeKey)}`;
      const url = `${base}?select=id&app_key=eq.${OPS_APP_KEY}&${filter}&limit=1`;
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error("os_activity_read_failed");
      const rows = (await response.json()) as Array<{ id: string }>;
      return rows.length > 0 ? rows[0].id : null;
    },
    insert: async (row: SuiteActivityRow) => {
      const response = await fetch(base, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
      // A unique violation means the row is already there: that is a
      // duplicate, not a failure.
      if (response.status === 409) return "duplicate";
      if (!response.ok) throw new Error("os_activity_write_failed");
      return "written";
    },
  };
}

/**
 * Sync one business-level Ops signal. Never throws and never blocks a run:
 * when the suite is unreachable or Ops was opened directly, this quietly
 * reports unavailable.
 */
export async function sendSuiteSignal(signal: OpsSuiteSignal): Promise<SuiteSyncResult> {
  const env = resolveOpsEnv();
  if (!isSuiteConfigured(env)) return { status: "unavailable", reason: "not_configured" };
  return syncSuiteSignal(signal, suiteDeps(), env.opsBaseUrl);
}

export function endSuiteSession(): void {
  clearSuiteSession();
}

/**
 * Upsert deps for the Core-side read projection. Writes go out with the Core
 * publishable key plus the signed-in Core user's bearer token, so Core RLS
 * decides what may be written — Ops never asserts cross-org access.
 */
function projectionDeps(): ProjectionSyncDeps | null {
  const env = resolveOpsEnv();
  const session = getSuiteSession();
  if (!session || !isSuiteConfigured(env)) return null;

  const base = `${(env.osSupabaseUrl ?? "").replace(/\/+$/, "")}/rest/v1/${OPS_PROJECTION_TABLE}`;
  const headers = OS_REST_HEADERS(session.osAccessToken, env.osSupabasePublicKey ?? "");

  return {
    context: { organizationId: session.osOrganizationId },
    upsert: async (rows: OpsProjectProjectionRow[]) => {
      const response = await fetch(`${base}?on_conflict=${OPS_PROJECTION_CONFLICT_TARGET}`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });
      // Core has not applied db/core-contract/ops_project_projection.sql yet.
      if (response.status === 404) return "contract_missing";
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (detail.includes("PGRST205")) return "contract_missing";
        throw new Error(`projection_write_failed_${response.status}`);
      }
      return "synced";
    },
  };
}

/**
 * Publish the current Ops project list into Core as a read projection.
 * Idempotent by construction (deterministic upsert key), fail-quiet, and
 * never blocking: Ops keeps working with no Core at all.
 */
export async function syncProjectProjection(projects: Project[]): Promise<ProjectionSyncResult> {
  const env = resolveOpsEnv();
  if (!isSuiteConfigured(env)) return { status: "unavailable", reason: "not_configured" };

  const deps = projectionDeps();
  if (!deps) return { status: "unavailable", reason: "no_os_session" };

  const rows = buildProjectionBatch(projects, deps.context, env.opsBaseUrl);
  return syncProjectionRows(rows, deps);
}