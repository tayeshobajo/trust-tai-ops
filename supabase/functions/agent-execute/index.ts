// Trust Tai Ops — agent execution gateway.
//
// The only place tool execution happens. The browser sends an identity
// (project, run, action) and never a credential, a capability claim, or a
// trusted URL for private work.
//
// Public read-only tools may run for the project's own callers as before.
// Private tools require a proven signed-in caller who belongs to the
// organization that owns the project, plus a server-resolvable secret.
// Nothing is ever simulated, and nothing in this pass mutates WordPress.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, secretStoreDeps, stackDeps } from "../_shared/clients.ts";
import { authorizeToolForStack, isWordPressTool } from "../_shared/stackGuard.ts";
import { fetchSafely, readBounded, redact, safeHeaders, validatePublicUrl } from "../_shared/net.ts";
import { capabilityTruth, resolveCredential } from "../_shared/secretStore.ts";
import { authenticatedGet, normalizeHealthTest, normalizePlugins } from "../_shared/wordpress.ts";
import { runReadOnlyWpCli } from "../_shared/wpCli.ts";
import { denoSftpTransport, denoSshTransport } from "../_shared/sshTransport.ts";
import { readWordPressErrorLog } from "../_shared/errorLog.ts";
import { isBrowserViewport, runBrowserInspection } from "../_shared/browserInspect.ts";

const fail = (code: string, summary: string, retryable: boolean) =>
  Response.json({ ok: false, code, summary, retryable }, { headers: corsHeaders });

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you to be signed in before I can use private access.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

const PRIVATE_TOOLS = new Set([
  "wordpress.list_plugins",
  "wordpress.run_wp_cli_readonly",
  "wordpress.read_error_log",
]);

/** Every access type whose credential the server can actually resolve. */
const EXECUTABLE_ACCESS_TYPES = ["wordpress_admin", "ssh"];

// --- public inspections (unchanged behaviour) -------------------------------

const inspectSite = async (rawUrl: string) => {
  const check = validatePublicUrl(rawUrl);
  if (!check.ok) return fail("unsafe_destination", check.reason, false);

  const startedAt = Date.now();
  const attempt = await fetchSafely(check.url);
  if ("error" in attempt) {
    return fail(
      attempt.error === "unsafe_destination" ? "unsafe_destination" : attempt.error,
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
    return fail(attempt.error === "unsafe_destination" ? "unsafe_destination" : attempt.error,
      "I could not reach the WordPress public interface from outside.", true);
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
        authenticationAdvertised: Boolean(payload.authentication && Object.keys(payload.authentication as object).length),
      },
    },
    { headers: corsHeaders },
  );
};

// --- health: public signals, deepened by real admin access ------------------

const publicHealthSignals = async (rawUrl: string) => {
  const check = validatePublicUrl(rawUrl);
  if (!check.ok) return { error: check.reason };
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

  if (!root || (root.error && root.status === null)) return { error: "unreachable" };

  let namespaces: string[] = [];
  try {
    const payload = JSON.parse(root.body ?? "") as Record<string, unknown>;
    namespaces = Array.isArray(payload.namespaces) ? (payload.namespaces as string[]).slice(0, 25) : [];
  } catch {
    namespaces = [];
  }

  const siteHealthStatus = siteHealth?.status ?? null;
  return {
    data: {
      siteHealthEndpointExists: namespaces.includes("wp-site-health/v1") || siteHealthStatus === 401 || siteHealthStatus === 403,
      credentialsRequired: siteHealthStatus === 401 || siteHealthStatus === 403,
      siteHealthStatus,
      namespaces,
      httpsEnabled: check.url.protocol === "https:",
      usersPubliclyListed: users?.status === 200 && (users.body ?? "").trim().startsWith("["),
      xmlrpcExposed: xmlrpc?.status === 200 || xmlrpc?.status === 405,
    },
  };
};

const SITE_HEALTH_TESTS = [
  "background-updates",
  "loopback-requests",
  "https-status",
  "dotorg-communication",
];

/** Authenticated Site Health. Only claims what a 200 response actually proved. */
const authenticatedHealth = async (baseUrl: string, projectId: string) => {
  const deps = secretStoreDeps();
  const resolved = await resolveCredential(deps, projectId, "wordpress_admin");
  if (!resolved.ok) return { available: false as const, code: resolved.code };

  const readable: Array<{ id: string; label: string; status: string | null }> = [];
  let unauthorized = false;
  let forbidden = false;
  let reachable = false;

  for (const test of SITE_HEALTH_TESTS) {
    const outcome = await authenticatedGet(
      baseUrl,
      `/wp-json/wp-site-health/v1/tests/${test}`,
      resolved.credential,
    );
    if (outcome.ok) {
      reachable = true;
      try {
        const normalized = normalizeHealthTest(test, JSON.parse(outcome.body));
        if (normalized) readable.push(normalized);
      } catch {
        // A non-JSON 200 proves nothing; it is simply not recorded.
      }
      continue;
    }
    if (outcome.kind === "unauthorized") unauthorized = true;
    if (outcome.kind === "forbidden") forbidden = true;
  }

  if (unauthorized || forbidden) {
    await deps.markVerification?.(projectId, "wordpress_admin", "rejected", null);
    return { available: false as const, code: unauthorized ? "unauthorized" : "forbidden" };
  }
  if (readable.length > 0) {
    await deps.markVerification?.(projectId, "wordpress_admin", "verified", new Date().toISOString());
  }

  return { available: reachable && readable.length > 0, tests: readable, code: null };
};

const readHealth = async (rawUrl: string, authorizedProjectId: string | null, canonicalUrl: string | null) => {
  const target = authorizedProjectId && canonicalUrl ? canonicalUrl : rawUrl;
  const publicSignals = await publicHealthSignals(target);
  if ("error" in publicSignals) {
    return fail("network_error", "I could not reach the site to read its health signals.", true);
  }

  let authenticated: Record<string, unknown> = {
    authenticatedHealthAvailable: false,
    authenticatedHealthCode: authorizedProjectId ? null : "capability_unavailable",
    authenticatedChecksRead: [] as unknown[],
  };

  if (authorizedProjectId && canonicalUrl) {
    const auth = await authenticatedHealth(canonicalUrl, authorizedProjectId);
    authenticated = {
      authenticatedHealthAvailable: auth.available,
      authenticatedHealthCode: auth.code ?? null,
      authenticatedChecksRead: auth.available ? auth.tests : [],
    };
  }

  const authAvailable = authenticated.authenticatedHealthAvailable === true;
  const summary = authAvailable
    ? "I read the private WordPress health checks with the stored admin access."
    : publicSignals.data.credentialsRequired
    ? "The WordPress health report is only readable with administrator access; I read the public health signals instead."
    : "The WordPress health report is not exposed here; I read the public health signals instead.";

  return Response.json(
    {
      ok: true,
      summary: redact(summary),
      data: { ...publicSignals.data, ...authenticated },
    },
    { headers: corsHeaders },
  );
};

// --- private: installed plugins --------------------------------------------

const listPlugins = async (projectId: string, canonicalUrl: string | null) => {
  if (!canonicalUrl) {
    return fail("execution_context_unavailable", "I don't have a confirmed site address for this project.", false);
  }

  const deps = secretStoreDeps();
  const resolved = await resolveCredential(deps, projectId, "wordpress_admin");
  if (!resolved.ok) {
    return fail(
      resolved.code,
      resolved.code === "secret_store_unavailable"
        ? "The secure credential store isn't available, so I won't attempt a private read."
        : "I don't have usable WordPress admin access stored for this project yet.",
      false,
    );
  }

  const outcome = await authenticatedGet(canonicalUrl, "/wp-json/wp/v2/plugins", resolved.credential);
  if (!outcome.ok) {
    if (outcome.kind === "unauthorized") {
      await deps.markVerification?.(projectId, "wordpress_admin", "rejected", null);
      return fail("unauthorized", "WordPress did not accept that Application Password. Please replace the WordPress Admin access.", false);
    }
    if (outcome.kind === "forbidden") {
      await deps.markVerification?.(projectId, "wordpress_admin", "rejected", null);
      return fail("forbidden", "That WordPress account is not allowed to read the plugin list.", false);
    }
    if (outcome.kind === "endpoint_unavailable") {
      return fail("not_implemented", "This WordPress install does not expose the plugins endpoint.", false);
    }
    if (outcome.kind === "unsafe") {
      return fail("unsafe_destination", "The site address for this project is not safe to call.", false);
    }
    return fail("network_error", "I could not reach WordPress to read the plugin list.", true);
  }

  let inventory: ReturnType<typeof normalizePlugins> = null;
  try {
    inventory = normalizePlugins(JSON.parse(outcome.body));
  } catch {
    inventory = null;
  }
  if (!inventory) {
    return fail("not_implemented", "WordPress answered, but not with a readable plugin list.", false);
  }

  await deps.markVerification?.(projectId, "wordpress_admin", "verified", new Date().toISOString());

  return Response.json(
    {
      ok: true,
      summary: redact(
        `I read ${inventory.total} installed plugins (${inventory.active} active, ${inventory.inactive} inactive).`,
      ),
      data: {
        total: inventory.total,
        active: inventory.active,
        inactive: inventory.inactive,
        truncated: inventory.truncated,
        plugins: inventory.plugins,
      },
    },
    { headers: corsHeaders },
  );
};

// --- entrypoint --------------------------------------------------------------

/**
 * Read-only WP-CLI over SSH.
 *
 * The browser supplies a catalog id and, at most, one bounded detail. The
 * server resolves the host, port, user, key and WordPress path itself, and the
 * command is composed from the closed catalog — never from client text.
 */
/**
 * Reads a bounded, sanitized tail of WordPress's own error logs. No path comes
 * from the client: the candidates are derived from the project's stored
 * WordPress root, plus — at most — the location WordPress itself reports.
 */
const readErrorLog = async (projectId: string) => {
  let debugLogHint: string | null = null;
  try {
    const configured = await runReadOnlyWpCli(secretStoreDeps(), denoSshTransport(), {
      projectId,
      commandId: "config.get_debug_log",
      params: {},
      allowFirstUse: false,
    });
    if (configured.ok) {
      const stdout = (configured.data as { stdout?: unknown } | undefined)?.stdout;
      if (typeof stdout === "string") debugLogHint = stdout.trim().split("\n")[0] ?? null;
    }
  } catch {
    // Discovery is a convenience. The fixed candidate list still applies.
  }

  const outcome = await readWordPressErrorLog(secretStoreDeps(), denoSftpTransport(), {
    projectId,
    debugLogHint,
  });

  if (!outcome.ok) return fail(outcome.code, outcome.summary, outcome.retryable);

  return Response.json(
    { ok: true, summary: redact(outcome.summary), data: outcome.data },
    { headers: corsHeaders },
  );
};

const runWpCli = async (projectId: string, args: Record<string, unknown>) => {
  const commandId = typeof args.commandId === "string" ? args.commandId : "";
  if (!commandId) {
    return fail("invalid_input", "That request didn't name an inspection to run.", false);
  }

  const params: Record<string, string | undefined> = {};
  for (const name of ["plugin", "option"]) {
    const value = args[name];
    if (typeof value === "string") params[name] = value;
  }

  const outcome = await runReadOnlyWpCli(secretStoreDeps(), denoSshTransport(), {
    projectId,
    commandId,
    params,
    // A normal run never trusts a new server identity. Only the explicit
    // human-initiated verification may record a first pin.
    allowFirstUse: false,
  });

  if (!outcome.ok) return fail(outcome.code, outcome.summary, outcome.retryable);

  return Response.json(
    { ok: true, summary: redact(outcome.summary), data: outcome.data },
    { headers: corsHeaders },
  );
};

/**
 * Stack-neutral, read-only page inspection in a real browser.
 *
 * The edge runtime cannot host a browser, so this delegates to an explicitly
 * configured rendering service and reports honestly when none is connected.
 * The address is scoped to the project's own site whenever the server knows it.
 */
const inspectPage = async (args: Record<string, unknown>, clientUrl: string, canonicalUrl: string | null) => {
  const url = canonicalUrl && !clientUrl ? canonicalUrl : clientUrl;
  if (!url) return fail("invalid_input", "That request was missing the page address.", false);

  const viewport = isBrowserViewport(args.viewport) ? args.viewport : "desktop";
  const outcome = await runBrowserInspection(
    {
      endpoint: Deno.env.get("BROWSER_INSPECT_ENDPOINT") ?? null,
      token: Deno.env.get("BROWSER_INSPECT_TOKEN") ?? null,
    },
    { url, viewport, allowedUrl: canonicalUrl },
  );

  if (!outcome.ok) return fail(outcome.code, outcome.summary, outcome.retryable);
  return Response.json({ ok: true, summary: outcome.summary, data: outcome.data }, { headers: corsHeaders });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_input", "That request could not be read.", false);
  }

  const mode = typeof body.mode === "string" ? body.mode : "execute";
  const toolId = typeof body.toolId === "string" ? body.toolId : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const args = (body.args ?? {}) as Record<string, unknown>;
  const clientUrl = typeof args.url === "string" ? args.url : "";
  const authorization = req.headers.get("Authorization");

  const needsServerTruth = mode === "capabilities" || PRIVATE_TOOLS.has(toolId) || toolId === "wordpress.read_health";
  // Every WordPress tool — public inspection included — needs proven project
  // ownership, because the stack decision has to come from the database.
  // The page inspector needs the project too: its canonical address is what
  // keeps the browser inside the site the project actually owns.
  const needsProject =
    needsServerTruth || isWordPressTool(toolId) || toolId === "browser.inspect_page_readonly";

  let authorizedProjectId: string | null = null;
  let canonicalUrl: string | null = null;

  if (needsProject) {
    if (!executionContextConfigured()) {
      // Fail closed: no proof of ownership means no private execution.
      if (mode === "capabilities" || isWordPressTool(toolId)) {
        return fail("execution_context_unavailable", "I can't verify project access from here yet.", false);
      }
    } else {
      const authz = await authorizeProject(authorization, projectId, authzDeps());
      if (authz.ok) {
        authorizedProjectId = authz.project.projectId;
        canonicalUrl = authz.project.canonicalUrl;
      } else if (mode === "capabilities" || isWordPressTool(toolId)) {
        return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code], false);
      }
    }
  }

  if (mode === "capabilities") {
    if (!authorizedProjectId) {
      return fail("execution_context_unavailable", "I can't confirm what access this project has.", false);
    }
    // `capabilities` are credentials this project holds and can attempt.
    // `verifiedCapabilities` are the ones the provider has already accepted.
    const truth = await capabilityTruth(secretStoreDeps(), authorizedProjectId, EXECUTABLE_ACCESS_TYPES);
    return Response.json(
      {
        ok: true,
        summary: "Confirmed the access this project actually holds.",
        data: { capabilities: truth.stored, verifiedCapabilities: truth.verified },
      },
      { headers: corsHeaders },
    );
  }

  if (!toolId) return fail("invalid_input", "That request was missing what I need to run a check.", false);

  // The authoritative stack gate. Nothing WordPress-specific — no HTTP probe,
  // no secret resolution, no SSH or SFTP session — is reached past this point
  // for a project that does not run WordPress.
  if (isWordPressTool(toolId)) {
    if (!authorizedProjectId) return fail("unauthorized", AUTH_FAIL_SUMMARY.unauthorized, false);
    const verdict = await authorizeToolForStack(stackDeps(), authorizedProjectId, toolId);
    if (!verdict.ok) return fail(verdict.code, verdict.summary, false);
  }

  // Proven above for every WordPress tool.
  const wpProjectId = authorizedProjectId ?? "";

  switch (toolId) {
    case "public_http.inspect_site":
      if (!clientUrl) return fail("invalid_input", "That request was missing the site address.", false);
      return await inspectSite(clientUrl);
    case "browser.inspect_page_readonly":
      return await inspectPage(args, clientUrl, canonicalUrl);
    case "wordpress.inspect_public_surface":
      // Canonical, server-resolved address first. The browser's URL is only a
      // fallback for the transitional case where no environment is recorded.
      if (!canonicalUrl && !clientUrl) {
        return fail("invalid_input", "That request was missing the site address.", false);
      }
      return await inspectPublicSurface(canonicalUrl ?? clientUrl);
    case "wordpress.read_health":
      if (!clientUrl && !canonicalUrl) {
        return fail("invalid_input", "That request was missing the site address.", false);
      }
      return await readHealth(clientUrl, authorizedProjectId, canonicalUrl);
    case "wordpress.list_plugins":
      return await listPlugins(wpProjectId, canonicalUrl);
    case "wordpress.run_wp_cli_readonly":
      return await runWpCli(wpProjectId, args);
    case "wordpress.read_error_log":
      return await readErrorLog(wpProjectId);
    default:
      return fail("not_implemented", "That capability is not enabled yet.", false);
  }
});
