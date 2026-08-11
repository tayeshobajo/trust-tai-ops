/**
 * Network safety primitives shared by every edge function.
 *
 * Pure TypeScript on purpose: no Deno-only globals and no npm specifiers, so
 * the same code that runs in production is exercised by the security checks.
 */

export const TIMEOUT_MS = 10_000;
export const MAX_BYTES = 512_000;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

export const isBlockedIp = (host: string): boolean => {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(":")) return true; // no raw IPv6 destinations
  return false;
};

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export const validatePublicUrl = (candidate: string): UrlCheck => {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "I can only check http or https addresses." };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "That address points inside a private network, so I won't check it." };
  }
  if (isBlockedIp(host)) {
    return { ok: false, reason: "That address points inside a private network, so I won't check it." };
  }
  return { ok: true, url };
};

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "www-authenticate",
  "x-api-key",
]);

const KEEP_HEADERS = new Set([
  "content-type",
  "server",
  "x-powered-by",
  "cache-control",
  "content-encoding",
  "location",
  "x-cache",
  "cf-cache-status",
]);

export const safeHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(name)) return;
    if (!KEEP_HEADERS.has(name)) return;
    out[name] = value.slice(0, 200);
  });
  return out;
};

export const redact = (value: string): string =>
  value
    .replace(/([?&](?:token|key|secret|password|pass|auth|signature)=)[^&\s]+/gi, "$1[redacted]")
    // Credential-shaped assignments anywhere in free text, not just in a query
    // string: console output and log lines carry them too.
    .replace(/\b(?:token|api[_-]?key|apikey|secret|password|passwd|pwd|authorization|bearer)\b\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");

/** Same scheme + host + port. Credentials never leave this boundary. */
export const isSameOrigin = (a: URL, b: URL): boolean => a.origin === b.origin;

export type FetchOptions = {
  headers?: Record<string, string>;
  method?: string;
  /** Header names dropped the moment a redirect leaves the original origin. */
  credentialHeaders?: string[];
};

export type FetchOutcome =
  | { response: Response; finalUrl: URL; hops: number; credentialsSurvived: boolean }
  | { error: "timeout" | "network_error" | "unsafe_destination" };

/**
 * Manual redirect walk. Every hop is re-validated against the SSRF rules, and
 * credential headers are stripped as soon as a hop leaves the original origin.
 */
export const fetchSafely = async (
  start: URL,
  options: FetchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> => {
  const credentialHeaders = (options.credentialHeaders ?? []).map((name) => name.toLowerCase());
  let current = start;
  let headers: Record<string, string> = {
    "user-agent": "TrustTaiOps/1.0 (+read-only site check)",
    ...(options.headers ?? {}),
  };
  let credentialsSurvived = credentialHeaders.length > 0;

  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method: options.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === "AbortError";
      return { error: aborted ? "timeout" : "network_error" };
    }
    clearTimeout(timer);

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = validatePublicUrl(new URL(location, current).toString());
      if (!next.ok) return { error: "unsafe_destination" };
      if (!isSameOrigin(next.url, start)) {
        // Cross-origin hop: the credential never travels with it.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => !credentialHeaders.includes(name.toLowerCase())),
        );
        credentialsSurvived = false;
      }
      current = next.url;
      continue;
    }
    return { response, finalUrl: current, hops: hop, credentialsSurvived };
  }
  return { error: "network_error" };
};

export const readBounded = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text.slice(0, MAX_BYTES);
};