/**
 * Credential submission from the browser.
 *
 * One direction only. A value goes out once, through the server endpoint, and
 * is never held, cached, or read back. Nothing here writes to localStorage, and
 * the response contains a reference plus metadata — never the secret.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "../env";
import { getSupabaseClient } from "../supabase";

/** Access types with a credential the server can actually execute with. */
export type ExecutableAccessType = "wordpress_admin" | "ssh" | "google_search_console";

export type SubmitCredentialInput = {
  projectId: string;
  accessType: ExecutableAccessType;
  username: string;
  /** Held only for the duration of this call. */
  secret: string;
  /**
   * Non-secret connection details for SSH. Never a credential, and ignored
   * for every other access type.
   */
  host?: string;
  port?: number;
  wpRoot?: string;
  wpBinary?: string;
  /** Custom WordPress admin/login address. Non-secret. */
  loginUrl?: string;
  /** Held only for the duration of this call, like `secret`. */
  passphrase?: string;
};
export type CredentialDetails = {
  exists: boolean;
  username: string;
  host: string;
  port: string;
  wpRoot: string;
  loginUrl: string;
};


export type SubmitCredentialResult =
  | { ok: true; secretReference: string; username: string; verificationState: string }
  | { ok: false; code: string; summary: string };

export type VerifyCredentialResult = {
  state: "verified" | "rejected" | "unverified";
  lastVerifiedAt: string | null;
  summary: string;
  code: string | null;
};

const UNAVAILABLE: SubmitCredentialResult = {
  ok: false,
  code: "secret_store_unavailable",
  summary: "The secure credential store isn't reachable from here, so nothing was stored.",
};

export const secretSubmissionAvailable = (): boolean => hasSupabasePublicConfig(resolveOpsEnv());

export const submitCredential = async (input: SubmitCredentialInput): Promise<SubmitCredentialResult> => {
  if (!secretSubmissionAvailable()) return UNAVAILABLE;

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.functions.invoke("access-secrets", {
      body: {
        projectId: input.projectId,
        accessType: input.accessType,
        username: input.username,
        secret: input.secret,
        ...(input.accessType === "ssh"
          ? {
              host: input.host ?? "",
              port: input.port ?? 22,
              wpRoot: input.wpRoot ?? "",
              wpBinary: input.wpBinary ?? "",
              passphrase: input.passphrase ?? "",
            }
          : { loginUrl: input.loginUrl ?? "" }),
      },
    });
    if (error) return UNAVAILABLE;

    const payload = data as
      | { ok?: boolean; code?: string; summary?: string; data?: Record<string, unknown> }
      | null;
    if (!payload || typeof payload.ok !== "boolean") return UNAVAILABLE;
    if (!payload.ok) {
      return {
        ok: false,
        code: typeof payload.code === "string" ? payload.code : "secret_store_unavailable",
        summary: typeof payload.summary === "string" ? payload.summary : UNAVAILABLE.summary,
      };
    }

    return {
      ok: true,
      secretReference: String(payload.data?.secretReference ?? ""),
      username: String(payload.data?.username ?? input.username),
      verificationState: String(payload.data?.verificationState ?? "unverified"),
    };
  } catch {
    // A transport error can carry URLs and headers; it is never surfaced.
    return UNAVAILABLE;
  }
};

/**
 * Non-secret details for a stored connection, so replacing access shows what
 * was entered before. Never returns a credential.
 */
export const loadCredentialDetails = async (
  projectId: string,
  accessType: ExecutableAccessType,
): Promise<CredentialDetails | null> => {
  if (!secretSubmissionAvailable()) return null;
  try {
    const client = getSupabaseClient();
    const { data, error } = await client.functions.invoke("access-secrets", {
      body: { mode: "details", projectId, accessType },
    });
    if (error) return null;
    const payload = data as { ok?: boolean; data?: Record<string, unknown> } | null;
    if (!payload?.ok) return null;
    const detail = (payload.data ?? {}) as Record<string, unknown>;
    const nested = (detail.details ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      exists: Boolean(detail.exists),
      username: text(detail.username),
      host: text(nested.host),
      port: text(nested.port),
      wpRoot: text(nested.wpRoot),
      loginUrl: text(nested.loginUrl),
    };
  } catch {
    return null;
  }
};

/**
 * Asks the server to prove a stored credential against the project's own
 * WordPress origin.
 *
 * The browser sends a project id and nothing else: no address, no username, no
 * secret. It cannot aim the check, and it cannot write the result — the server
 * updates the verification metadata itself.
 */
export const verifyStoredCredential = async (
  projectId: string,
  accessType: ExecutableAccessType = "wordpress_admin",
): Promise<VerifyCredentialResult> => {
  const unreachable: VerifyCredentialResult = {
    state: "unverified",
    lastVerifiedAt: null,
    code: "secret_store_unavailable",
    summary: "I couldn't reach the verification service, so nothing about that access changed.",
  };
  if (!secretSubmissionAvailable()) return unreachable;

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.functions.invoke("access-secrets", {
      body: { mode: "verify", projectId, accessType },
    });
    if (error) return unreachable;

    const payload = data as
      | { ok?: boolean; code?: string; summary?: string; data?: Record<string, unknown> }
      | null;
    if (!payload) return unreachable;

    const state = String(payload.data?.verificationState ?? "unverified");
    const at = payload.data?.lastVerifiedAt;
    return {
      state: state === "verified" || state === "rejected" ? state : "unverified",
      // A timestamp only ever comes back from a real acceptance.
      lastVerifiedAt: state === "verified" && typeof at === "string" ? at : null,
      code: typeof payload.code === "string" ? payload.code : null,
      summary: typeof payload.summary === "string" ? payload.summary : unreachable.summary,
    };
  } catch {
    return unreachable;
  }
};