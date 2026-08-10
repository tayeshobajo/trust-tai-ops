// Trust Tai Ops — agent execution gateway.
//
// The only place privileged/agent tool execution happens. The browser sends an
// identity (project, run, action) and never a credential; this function
// resolves execution context server-side.
//
// Implemented in this pass: two public, read-only inspections. Everything else
// answers honestly that it is not available. Nothing is ever simulated.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 512_000;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

const isBlockedIp = (host: string): boolean => {
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

type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const validatePublicUrl = (candidate: string): UrlCheck => {
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

const safeHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(name)) return;
    if (!KEEP_HEADERS.has(name)) return;
    out[name] = value.slice(0, 200);
  });
  return out;
};

const redact = (value: string): string =>
  value
    .replace(/([?&](?:token|key|secret|password|pass|auth|signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");

/** Manual redirect walk, so every hop is re-validated against SSRF rules. */
const fetchSafely = async (
  start: URL,
  init: RequestInit = {},
): Promise<{ response: Response; finalUrl: URL; hops: number } | { error: string }> => {
  let current = start;
  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "TrustTaiOps/1.0 (+read-only site check)", ...(init.headers ?? {}) },
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
      current = next.url;
      continue;
    }
    return { response, finalUrl: current, hops: hop };
  }
  return { error: "network_error" };
};

const readBounded = async (response: Response): Promise<string> => {
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

const fail = (code: string, summary: string, retryable: boolean) =>
  Response.json({ ok: false, code, summary, retryable }, { headers: corsHeaders });

const inspectSite = async (rawUrl: string) => {
  const check = validatePublicUrl(rawUrl);
  if (!check.ok) return fail("unsafe_destination", check.reason, false);

  const startedAt = Date.now();
  const attempt = await fetchSafely(check.url);
  if ("error" in attempt) {
    return fail(
      attempt.error,
      attempt.error === "timeout"
        ? "The site did not respond in time when I checked it from outside."
        : "I could not reach the site from outside at all.",
      true,
    );
  }

  const durationMs = Date.now() - startedAt;
  const { response, finalUrl, hops } = attempt;
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const body = isHtml ? await readBounded(response) : "";
  if (!isHtml) await response.body?.cancel().catch(() => undefined);

  const title = body.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim() ?? null;
  const generator = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{0,120})["']/i)?.[1] ?? null;

  return Response.json(
    {
      ok: true,
      summary: redact(`The site answered ${response.status} in ${durationMs}ms.`),
      data: {
        status: response.status,
        finalUrl: redact(finalUrl.toString()),
        redirected: hops > 0,
        redirectHops: hops,
        durationMs,
        contentType: contentType.slice(0, 120),
        headers: safeHeaders(response.headers),
        title: title ? redact(title).slice(0, 200) : null,
        generator: generator ? redact(generator) : null,
        wordpressSignals: /wp-content|wp-includes/i.test(body) || /wordpress/i.test(generator ?? ""),
      },
    },
    { headers: corsHeaders },
  );
};

const inspectPublicSurface = async (rawUrl: string) => {
  const check = validatePublicUrl(rawUrl);
  if (!check.ok) return fail("unsafe_destination", check.reason, false);

  const restUrl = new URL("/wp-json/", check.url.origin);
  const attempt = await fetchSafely(restUrl, { headers: { accept: "application/json" } });
  if ("error" in attempt) {
    return fail(
      attempt.error,
      "I could not reach the WordPress public interface from outside.",
      true,
    );
  }

  const { response } = attempt;
  const available = response.ok && (response.headers.get("content-type") ?? "").includes("json");
  let payload: Record<string, unknown> = {};
  if (available) {
    try {
      payload = JSON.parse(await readBounded(response)) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }

  const namespaces = Array.isArray(payload.namespaces) ? (payload.namespaces as string[]).slice(0, 25) : [];

  return Response.json(
    {
      ok: true,
      summary: redact(
        available
          ? "The WordPress public interface responded."
          : `The WordPress public interface answered ${response.status}.`,
      ),
      data: {
        restApiAvailable: available,
        status: response.status,
        siteName: typeof payload.name === "string" ? redact(payload.name).slice(0, 120) : null,
        description: typeof payload.description === "string" ? redact(payload.description).slice(0, 200) : null,
        namespaces,
        // Only what WordPress already publishes to anonymous visitors.
        authenticationAdvertised: Boolean(payload.authentication && Object.keys(payload.authentication as object).length),
      },
    },
    { headers: corsHeaders },
  );
};

/**
 * Site health, read-only.
 *
 * Runs server-side capability checks first: it probes what can actually be
 * read from this site right now, and reports honestly which parts of the
 * WordPress health report need administrator credentials. Nothing is guessed.
 */
const readHealth = async (rawUrl: string) => {
  const check = validatePublicUrl(rawUrl);
  if (!check.ok) return fail("unsafe_destination", check.reason, false);

  const origin = check.url.origin;

  const probe = async (path: string, accept: string) => {
    const target = validatePublicUrl(new URL(path, origin).toString());
    if (!target.ok) return null;
    const attempt = await fetchSafely(target.url, { headers: { accept } });
    if ("error" in attempt) return { status: null as number | null, body: "", error: attempt.error };
    const { response } = attempt;
    const type = response.headers.get("content-type") ?? "";
    const body = type.includes("json") || type.includes("text/") ? await readBounded(response) : "";
    if (!body) await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body, error: null as string | null };
  };

  const [siteHealth, users, xmlrpc, root] = await Promise.all([
    probe("/wp-json/wp-site-health/v1/tests/background-updates", "application/json"),
    probe("/wp-json/wp/v2/users", "application/json"),
    probe("/xmlrpc.php", "text/html"),
    probe("/wp-json/", "application/json"),
  ]);

  if (!root || (root.error && root.status === null)) {
    return fail("network_error", "I could not reach the site to read its health signals.", true);
  }

  let namespaces: string[] = [];
  try {
    const payload = JSON.parse(root.body ?? "") as Record<string, unknown>;
    namespaces = Array.isArray(payload.namespaces) ? (payload.namespaces as string[]).slice(0, 25) : [];
  } catch {
    namespaces = [];
  }

  const siteHealthStatus = siteHealth?.status ?? null;
  const siteHealthEndpointExists = namespaces.includes("wp-site-health/v1") || siteHealthStatus === 401 ||
    siteHealthStatus === 403;
  const authenticatedHealthAvailable = siteHealthStatus === 200;
  const credentialsRequired = siteHealthStatus === 401 || siteHealthStatus === 403;

  const usersPubliclyListed = users?.status === 200 && (users.body ?? "").trim().startsWith("[");
  const xmlrpcExposed = xmlrpc?.status === 200 || xmlrpc?.status === 405;

  const readable: string[] = [];
  const needsCredentials: string[] = [];
  (siteHealthEndpointExists ? needsCredentials : readable).push("WordPress site health report");
  readable.push("Transport security", "Public author exposure", "XML-RPC exposure");
  if (authenticatedHealthAvailable) {
    readable.push("WordPress site health report");
    needsCredentials.length = 0;
  }

  const summary = authenticatedHealthAvailable
    ? "I read the WordPress site health report."
    : credentialsRequired
    ? "The WordPress site health report exists but is only readable with administrator access; I read the public health signals instead."
    : "The WordPress site health report is not exposed here; I read the public health signals instead.";

  return Response.json(
    {
      ok: true,
      summary: redact(summary),
      data: {
        siteHealthEndpointExists,
        authenticatedHealthAvailable,
        credentialsRequired,
        siteHealthStatus,
        namespaces,
        httpsEnabled: check.url.protocol === "https:",
        usersPubliclyListed,
        xmlrpcExposed,
        readableChecks: Array.from(new Set(readable)),
        checksNeedingCredentials: Array.from(new Set(needsCredentials)),
      },
    },
    { headers: corsHeaders },
  );
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_input", "That request could not be read.", false);
  }

  const toolId = typeof body.toolId === "string" ? body.toolId : "";
  const args = (body.args ?? {}) as Record<string, unknown>;
  const url = typeof args.url === "string" ? args.url : "";

  if (!toolId || !url) return fail("invalid_input", "That request was missing what I need to run a check.", false);

  switch (toolId) {
    case "public_http.inspect_site":
      return await inspectSite(url);
    case "wordpress.inspect_public_surface":
      return await inspectPublicSurface(url);
    case "wordpress.read_health":
      return await readHealth(url);
    default:
      return fail("not_implemented", "That capability is not enabled yet.", false);
  }
});
