/**
 * Trust Tai OS -> Ops SSO bridge (browser side).
 *
 * The only thing that crosses the origin boundary is a `postMessage` from an
 * exactly-matched Trust Tai OS origin. No access token is ever placed in a
 * query string, a hash, or `localStorage`. The token that arrives here is held
 * in memory only, exchanged server-side immediately, and then dropped.
 *
 * Everything in this file is pure so it can be exercised without a browser.
 */

export const SSO_MESSAGE_TYPE = "trust-tai-os:sso";
export const SSO_READY_TYPE = "trust-tai-ops:sso-ready";

export type SsoHandoff = {
  accessToken: string;
  /**
   * The current Trust Tai OS organization. Carried so Ops can address the
   * right OS rows — never as an authorization claim. OS row-level security
   * still decides whether the write is allowed.
   */
  organizationId: string;
  canonicalProjectId: string | null;
  returnContext: string | null;
  /** Sanitized same-app destination path to land on after sign-in. */
  targetPath: string | null;
};

export type SsoRejection =
  | "origin_rejected"
  | "not_a_handoff"
  | "missing_token"
  | "malformed_token"
  | "missing_organization_id"
  | "malformed_organization_id"
  | "malformed_project_id";

/**
 * Accepts only a same-app absolute path. Anything that could leave the app —
 * a scheme, a protocol-relative `//host`, a backslash, an encoded escape, a
 * control character — is refused rather than repaired.
 */
export function sanitizeTargetPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\") || value.includes("..")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
  if (/^\/+\s*[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (/%2f%2f/i.test(value) || /%5c/i.test(value)) return null;
  if (!/^\/[A-Za-z0-9\-._~/]*(\?[A-Za-z0-9\-._~=&%]*)?$/.test(value)) return null;
  // Never let a handoff land back on the handoff surface.
  if (isSsoLandingPath(value.split("?")[0])) return null;
  return value;
}

/** The Ops project a sanitized target path deep-links to, when it names one. */
export function projectIdFromTargetPath(path: string | null): string | null {
  if (!path) return null;
  const match = path.split("?")[0].match(/^\/(?:projects?)\/([0-9a-f-]{36})\/?$/i);
  if (!match) return null;
  return UUID.test(match[1]) ? match[1].toLowerCase() : null;
}

export type SsoReadResult =
  | { ok: true; handoff: SsoHandoff }
  | { ok: false; reason: SsoRejection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Parses a comma-separated browser-safe allowlist into exact origins.
 * Wildcards are dropped rather than expanded: `*` is never an allowed origin.
 */
export function parseOriginAllowlist(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0 && !entry.includes("*"))
    .filter((entry) => /^https?:\/\/[^/\s]+$/.test(entry));
}

/** Exact-match only. No prefix, suffix, or wildcard matching. */
export function isAllowedOrigin(origin: string | undefined | null, allowlist: string[]): boolean {
  if (!origin) return false;
  const normalized = origin.trim().replace(/\/+$/, "");
  if (normalized === "null" || normalized.includes("*")) return false;
  return allowlist.includes(normalized);
}

/**
 * Reads one `message` event. Rejects anything that is not a well-formed
 * handoff from an exactly allowed origin.
 */
export function readHandoffMessage(
  event: { origin?: string | null; data?: unknown },
  allowlist: string[],
): SsoReadResult {
  if (!isAllowedOrigin(event.origin, allowlist)) {
    return { ok: false, reason: "origin_rejected" };
  }

  const data = event.data;
  if (!data || typeof data !== "object") return { ok: false, reason: "not_a_handoff" };

  const payload = data as Record<string, unknown>;
  if (payload.type !== SSO_MESSAGE_TYPE) return { ok: false, reason: "not_a_handoff" };

  const token = payload.accessToken;
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing_token" };
  if (!JWT_SHAPE.test(token)) return { ok: false, reason: "malformed_token" };

  const organizationRaw = payload.organizationId;
  if (typeof organizationRaw !== "string" || organizationRaw.length === 0) {
    return { ok: false, reason: "missing_organization_id" };
  }
  if (!UUID.test(organizationRaw)) return { ok: false, reason: "malformed_organization_id" };
  const organizationId = organizationRaw.toLowerCase();

  const canonicalRaw = payload.canonicalProjectId;
  let canonicalProjectId: string | null = null;
  if (typeof canonicalRaw === "string" && canonicalRaw.length > 0) {
    if (!UUID.test(canonicalRaw)) return { ok: false, reason: "malformed_project_id" };
    canonicalProjectId = canonicalRaw.toLowerCase();
  }

  const returnRaw = payload.returnContext;
  const returnContext =
    typeof returnRaw === "string" && returnRaw.length > 0 && returnRaw.length <= 512 ? returnRaw : null;

  const targetPath = sanitizeTargetPath(payload.targetPath ?? payload.target_path);

  return {
    ok: true,
    handoff: { accessToken: token, organizationId, canonicalProjectId, returnContext, targetPath },
  };
}

/**
 * Guard used by tests and by the landing state: a token must never appear in
 * the address bar, because URLs leak into history, referrers, and logs.
 */
export function locationCarriesToken(href: string): boolean {
  return /(?:access_token|id_token|refresh_token|token_hash|bearer)=/i.test(href);
}

/** True when the app was opened as the OS suite handoff landing surface. */
export function isSsoLandingPath(pathname: string): boolean {
  return /^\/sso\/?$/.test(pathname);
}