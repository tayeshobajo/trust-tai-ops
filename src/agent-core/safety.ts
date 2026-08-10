/**
 * Network and output safety for agent tools.
 *
 * Two jobs: keep the agent from reaching somewhere it must not reach, and keep
 * anything credential-shaped out of evidence, messages, logs and audit records.
 */

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: "invalid_input" | "unsafe_destination"; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const isIpv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** Loopback, private, link-local, CGNAT and cloud metadata ranges. */
const isPrivateIpv4 = (host: string): boolean => {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
};

const isPrivateIpv6 = (host: string): boolean => {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return false;
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fe80") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("::ffff:")
  );
};

/**
 * Validates a destination for public HTTP tools. Applied to the project URL and
 * to every redirect hop, because a public host can redirect inward.
 */
export const validatePublicUrl = (candidate: string): UrlCheck => {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return { ok: false, code: "invalid_input", reason: "That does not look like a valid web address." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "invalid_input", reason: "Only http and https addresses can be checked." };
  }

  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, code: "invalid_input", reason: "That address has no host." };
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { ok: false, code: "unsafe_destination", reason: "That address points at an internal host." };
  }
  if (isIpv4(host) && isPrivateIpv4(host)) {
    return { ok: false, code: "unsafe_destination", reason: "That address points at a private network." };
  }
  if (isPrivateIpv6(host)) {
    return { ok: false, code: "unsafe_destination", reason: "That address points at a private network." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "unsafe_destination", reason: "Addresses with embedded credentials are not accepted." };
  }

  return { ok: true, url };
};

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "www-authenticate",
]);

/** Header allow-list plus redaction, so nothing session-bearing is captured. */
export const redactHeaders = (headers: Record<string, string>): Record<string, string> => {
  const safe: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    safe[key] = SENSITIVE_HEADERS.has(key) ? "[redacted]" : redactText(value);
  }
  return safe;
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/([?&](?:token|key|api_key|apikey|password|pwd|secret|signature|sig|access_token)=)[^&\s"']+/gi, "$1[redacted]"],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S+/gi, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9]{12,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]"],
];

/** Removes credential-shaped substrings from anything we are about to persist. */
export const redactText = (value: string): string =>
  SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);

/** Bounded, redacted text for evidence and audit summaries. */
export const safeSummary = (value: string, limit = 240): string => {
  const cleaned = redactText(value).replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
};
