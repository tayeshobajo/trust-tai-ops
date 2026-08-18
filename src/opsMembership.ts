/**
 * Client for the Ops membership admin surface.
 *
 * Nothing here decides access: the browser only asks. Admin authority is
 * checked server-side against the caller's verified session in the
 * `ops-membership` function.
 */

import { getSupabaseClient } from "./supabase";

export type OpsRole = "viewer" | "operator" | "senior_operator" | "admin";

export type OpsMember = {
  id: string;
  organization_id: string;
  full_name: string;
  email: string;
  role: OpsRole;
  status: string;
  created_at: string;
  updated_at: string;
};

export type MembershipFailure = { ok: false; error: string; detail?: string };

const FAILURE_COPY: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  not_an_admin: "Only an Ops admin can change who has access.",
  invalid_email: "That does not look like an email address.",
  email_in_another_workspace: "That address already belongs to another workspace.",
  member_not_found: "That address does not have an Ops membership.",
  cannot_revoke_self: "You cannot remove your own Ops access.",
  not_configured: "Ops membership administration is not configured for this deployment.",
};

export function membershipFailureCopy(error: string, email?: string): string {
  const base = FAILURE_COPY[error] ?? "That change could not be completed.";
  if (email && error === "member_not_found") return `${email} does not have an Ops membership.`;
  return base;
}

async function callMembership<T>(body: Record<string, unknown>): Promise<({ ok: true } & T) | MembershipFailure> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client.functions.invoke("ops-membership", { body });

    if (error) {
      const context = (error as { context?: { clone?: () => Response; json?: () => Promise<unknown> } }).context;
      if (context?.json) {
        try {
          const parsed = (await (context.clone ? context.clone().json() : context.json())) as {
            error?: unknown;
            detail?: unknown;
          };
          if (typeof parsed?.error === "string") {
            return { ok: false, error: parsed.error, detail: typeof parsed.detail === "string" ? parsed.detail : undefined };
          }
        } catch {
          // Fall through to the generic failure below.
        }
      }
      return { ok: false, error: "request_failed", detail: error.message };
    }

    return data as { ok: true } & T;
  } catch (error) {
    return { ok: false, error: "request_failed", detail: error instanceof Error ? error.message : undefined };
  }
}

export function listOpsMembers() {
  return callMembership<{ members: OpsMember[] }>({ action: "list" });
}

export function grantOpsAccess(input: { email: string; fullName?: string; role?: OpsRole }) {
  return callMembership<{ member: OpsMember }>({
    action: "grant",
    email: input.email,
    fullName: input.fullName,
    role: input.role,
  });
}

export function revokeOpsAccess(email: string) {
  return callMembership<{ member: OpsMember }>({ action: "revoke", email });
}
