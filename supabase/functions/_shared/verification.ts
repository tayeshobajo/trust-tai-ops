/**
 * Server-side credential verification.
 *
 * "Stored" and "verified" are different facts and this module is the only
 * thing allowed to turn the first into the second. It resolves the sealed
 * credential itself, calls the project's own canonical WordPress origin with a
 * bounded read-only request, and reports only the outcome. No URL from the
 * browser reaches it, and the credential never leaves.
 */

import { resolveCredential, type SecretStoreDeps } from "./secretStore.ts";
import { authenticatedGet } from "./wordpress.ts";

export type VerificationState = "unverified" | "verified" | "rejected";

export type VerificationOutcome = {
  state: VerificationState;
  /** Only ever set when WordPress actually accepted the credential. */
  lastVerifiedAt: string | null;
  code: string | null;
  summary: string;
};

/** The cheapest authenticated read that proves an Application Password works. */
export const VERIFICATION_PATH = "/wp-json/wp/v2/users/me?context=edit";

export const verifyStoredWordPressCredential = async (
  deps: SecretStoreDeps,
  projectId: string,
  canonicalUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<VerificationOutcome> => {
  if (!canonicalUrl) {
    return {
      state: "unverified",
      lastVerifiedAt: null,
      code: "execution_context_unavailable",
      summary: "I don't have a confirmed site address for this project, so I can't check that access yet.",
    };
  }

  const resolved = await resolveCredential(deps, projectId, "wordpress_admin");
  if (!resolved.ok) {
    return {
      state: "unverified",
      lastVerifiedAt: null,
      code: resolved.code,
      summary:
        resolved.code === "secret_store_unavailable"
          ? "The secure credential store isn't available, so I didn't attempt a check."
          : "There's no stored WordPress admin access for this project yet.",
    };
  }

  const outcome = await authenticatedGet(canonicalUrl, VERIFICATION_PATH, resolved.credential, fetchImpl);

  if (outcome.ok) {
    const verifiedAt = new Date().toISOString();
    await deps.markVerification?.(projectId, "wordpress_admin", "verified", verifiedAt);
    return {
      state: "verified",
      lastVerifiedAt: verifiedAt,
      code: null,
      summary: "WordPress accepted that access. I can read privately without changing anything.",
    };
  }

  if (outcome.kind === "unauthorized" || outcome.kind === "forbidden") {
    // A real rejection. Recorded, but never explained in a way that describes
    // the credential itself.
    await deps.markVerification?.(projectId, "wordpress_admin", "rejected", null);
    return {
      state: "rejected",
      lastVerifiedAt: null,
      code: outcome.kind,
      summary:
        outcome.kind === "unauthorized"
          ? "WordPress did not accept that Application Password. Please replace the WordPress Admin access."
          : "That WordPress account signed in but isn't allowed to read administrator data.",
    };
  }

  // Unreachable or unsupported is not the credential's fault, so the stored
  // state is left exactly as it was.
  return {
    state: "unverified",
    lastVerifiedAt: null,
    code: outcome.kind === "unsafe" ? "unsafe_destination" : outcome.kind === "endpoint_unavailable" ? "not_implemented" : "network_error",
    summary:
      outcome.kind === "endpoint_unavailable"
        ? "This WordPress install doesn't expose the endpoint I use to check access."
        : "I couldn't reach WordPress to check that access, so nothing changed.",
  };
};
