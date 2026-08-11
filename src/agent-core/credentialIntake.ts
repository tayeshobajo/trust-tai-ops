/**
 * Chat-native credential handoff.
 *
 * The composer's raw text goes out exactly once, to one authorized server
 * endpoint, and is never held, cached, echoed or persisted here. The response
 * carries a sanitized message and safe status labels — never a secret.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "../env";
import { getSupabaseClient } from "../supabase";
import type { AccessType } from "../types";

export type IntakeAccessType = AccessType | "ftp";

export type IntakeStoredItem = {
  accessType: IntakeAccessType;
  provider: string;
  /** Safe mode label, e.g. "Application Password" or "Login password". */
  mode: string;
  verification: "verified" | "rejected" | "unverified" | "needs_attention" | "unsupported";
};

export type CredentialIntakeResult =
  | {
      ok: true;
      site: string;
      /** Sanitized replacement for the raw paste. */
      message: string[];
      reply: string[];
      stored: IntakeStoredItem[];
      missing: Array<{ accessType: IntakeAccessType; fields: string[] }>;
    }
  | { ok: false; code: string; summary: string; message: string[] };

const UNAVAILABLE: CredentialIntakeResult = {
  ok: false,
  code: "secret_store_unavailable",
  summary: "The secure credential store isn't reachable from here, so nothing was stored.",
  message: [],
};

export const credentialIntakeAvailable = (): boolean => hasSupabasePublicConfig(resolveOpsEnv());

export const submitCredentialText = async (input: {
  projectId: string;
  /** Held only for the duration of this call. */
  text: string;
  intakeKey: string;
}): Promise<CredentialIntakeResult> => {
  if (!credentialIntakeAvailable()) return UNAVAILABLE;

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.functions.invoke("credential-intake", {
      body: { projectId: input.projectId, text: input.text, intakeKey: input.intakeKey },
    });
    if (error) return UNAVAILABLE;

    const payload = data as
      | { ok?: boolean; code?: string; summary?: string; data?: Record<string, unknown> }
      | null;
    if (!payload || typeof payload.ok !== "boolean") return UNAVAILABLE;

    const detail = (payload.data ?? {}) as Record<string, unknown>;
    const lines = Array.isArray(detail.message) ? (detail.message as string[]) : [];

    if (!payload.ok) {
      return {
        ok: false,
        code: typeof payload.code === "string" ? payload.code : "secret_store_unavailable",
        summary: typeof payload.summary === "string" ? payload.summary : UNAVAILABLE.summary,
        message: lines,
      };
    }

    return {
      ok: true,
      site: String(detail.site ?? ""),
      message: lines,
      reply: Array.isArray(detail.reply) ? (detail.reply as string[]) : [],
      stored: Array.isArray(detail.stored) ? (detail.stored as IntakeStoredItem[]) : [],
      missing: Array.isArray(detail.missing)
        ? (detail.missing as Array<{ accessType: IntakeAccessType; fields: string[] }>)
        : [],
    };
  } catch {
    // A transport error can carry the request body; it is never surfaced.
    return UNAVAILABLE;
  }
};
