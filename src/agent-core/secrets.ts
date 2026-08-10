/**
 * Credential submission from the browser.
 *
 * One direction only. A value goes out once, through the server endpoint, and
 * is never held, cached, or read back. Nothing here writes to localStorage, and
 * the response contains a reference plus metadata — never the secret.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "../env";
import { getSupabaseClient } from "../supabase";

export type SubmitCredentialInput = {
  projectId: string;
  accessType: "wordpress_admin";
  username: string;
  /** Held only for the duration of this call. */
  secret: string;
};

export type SubmitCredentialResult =
  | { ok: true; secretReference: string; username: string; verificationState: string }
  | { ok: false; code: string; summary: string };

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