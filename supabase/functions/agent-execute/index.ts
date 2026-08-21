// Trust Tai Ops — agent execution gateway.
//
// The only place tool execution happens. The browser sends an identity
// (project, run, action) and never a credential, a capability claim, or a
// trusted URL for private work.
//
// Public read-only tools may run for the project's own callers as before.
// Private tools require a proven signed-in caller who belongs to the
// organization that owns the project, plus a server-resolvable secret.
// Write-path tools are now included. Every write requires server-resolved
// credentials and runs only against the authorized project's canonical origin.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, secretStoreDeps, stackDeps } from "../_shared/clients.ts";
import { authorizeToolForStack, isWordPressTool } from "../_shared/stackGuard.ts";
import { fetchSafely, readBounded, redact, safeHeaders, validatePublicUrl } from "../_shared/net.ts";
import { capabilityTruth, resolveCredential, resolveRawSecret } from "../_shared/secretStore.ts";
import { loginPathFromConfig } from "../_shared/verification.ts";
import { openWordPressSession } from "../_shared/wpSession.ts";
import {
  authenticatedGet,
  authenticatedPost,
  authenticatedPut,
  authenticatedPatch,
  authenticatedDelete,
  wpCodeSnippetAction,
  wpCodeSnippetCreate,
  normalizeHealthTest,
  normalizePlugins,
  pluginsFromAdminHtml,
} from "../_shared/wordpress.ts";
import { runReadOnlyWpCli, resolveSshAccess } from "../_shared/wpCli.ts";
import { buildWpCliWriteCommand } from "../_shared/wpCliWriteCatalog.ts";
import { denoSftpTransport, denoSshTransport } from "../_shared/sshTransport.ts";
import { readWordPressErrorLog } from "../_shared/errorLog.ts";
import { isBrowserViewport, runBrowserInspection, sanitizeElementQuery } from "../_shared/browserInspect.ts";

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
const EXECUTABLE_ACCESS_TYPES = ["wordpress_admin", "ssh", "sftp"];

/** SFTP and SSH are one server capability as far as the tool catalog is concerned. */
const withServerCapability = (list: string[]): string[] =>
  list.includes("sftp") && !list.includes("ssh") ? [...list, "ssh"] : list;

/**
 * One authenticated reader for the whole request.
 *
 * It tries REST Basic auth first, and — when WordPress answers 401 because the
 * host strips Authorization or because the stored credential is a normal login
 * password — falls back to a real signed-in session opened against the site's
 * own login form. Only when both paths refuse is the access genuinely rejected,
 * so the agent stops contradicting an access panel that says "verified".
 */
const privateReader = async (projectId: string, canonicalUrl: string) => {
  const deps = secretStoreDeps();
  const resolved = await resolveCredential(deps, projectId, "wordpress_admin");
  if (!resolved.ok) return { ok: false as const, code: resolved.code, deps };

  const raw = await resolveRawSecret(deps, projectId, "wordpress_admin");
  const loginPath = raw.ok ? loginPathFromConfig(raw.row.config, canonicalUrl) : null;
  const loginOnly = resolved.provider === "wordpress_login_password";

  let session: { cookie: string; nonce: string | null } | null = null;
  let sessionTried = false;

  const openSession = async (): Promise<{ cookie: string; nonce: string | null } | null> => {
    if (sessionTried) return session;
    sessionTried = true;
    const opened = await openWordPressSession(
      canonicalUrl,
      { username: resolved.credential.username, password: resolved.credential.applicationPassword },
      fetch,
      loginPath ?? undefined,
    );
    session = opened.ok ? { cookie: opened.cookie, nonce: opened.nonce } : null;
    return session;
  };

  const get = async (path: string) => {
    if (!loginOnly) {
      const direct = await authenticatedGet(canonicalUrl, path, resolved.credential);
      if (direct.ok || (direct.kind !== "unauthorized" && direct.kind !== "forbidden")) return direct;
    }
    const signedIn = await openSession();
    if (!signedIn) {
      return loginOnly
        ? ({ ok: false, kind: "unauthorized", status: 401 } as const)
        : await authenticatedGet(canonicalUrl, path, resolved.credential);
    }
    return authenticatedGet(canonicalUrl, path, null, fetch, signedIn.cookie, signedIn.nonce);
  };

  /**
   * The same read a person would do in a browser: a signed-in GET of an admin
   * page. Used only when the REST route refuses, and only ever for reading.
   */
  const getAdminPage = async (path: string) => {
    const signedIn = await openSession();
    if (!signedIn) return null;
    const outcome = await authenticatedGet(canonicalUrl, path, null, fetch, signedIn.cookie, signedIn.nonce);
    return outcome.ok ? outcome.body : null;
  };

  return { ok: true as const, deps, get, getAdminPage };
};

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

/**
 * Read-only search-visibility surface.
 *
 * Everything here is served publicly by the site itself: robots.txt, the
 * sitemap, and the head of the home page. Nothing is changed, and nothing is
 * inferred from third-party tools the agent cannot reach.
 */
const inspectSeoSurface = async (rawUrl: string) => {
  const check = validatePublicUrl(rawUrl);
  if (!check.ok) return fail("unsafe_destination", check.reason, false);

  const origin = check.url.origin;

  const readText = async (target: URL) => {
    const attempt = await fetchSafely(target);
    if ("error" in attempt) return null;
    const { response } = attempt;
    const contentType = response.headers.get("content-type") ?? "";
    const body = await readBounded(response);
    return { status: response.status, body, contentType };
  };

  const page = await readText(check.url);
  if (!page) {
    return fail("unreachable", "I could not load the page to read its search signals.", true);
  }

  const robots = await readText(new URL("/robots.txt", origin));
  const sitemapFromRobots = robots?.body.match(/^\s*sitemap:\s*(\S+)/im)?.[1] ?? null;
  let sitemapUrl: string | null = null;
  let sitemapStatus: number | null = null;
  let sitemapUrlCount: number | null = null;
  try {
    const candidate = new URL(sitemapFromRobots ?? "/sitemap.xml", origin);
    if (candidate.origin === origin) {
      const sitemap = await readText(candidate);
      if (sitemap) {
        sitemapUrl = candidate.toString();
        sitemapStatus = sitemap.status;
        sitemapUrlCount = sitemap.status < 400 ? (sitemap.body.match(/<loc>/gi) ?? []).length : null;
      }
    }
  } catch {
    // A malformed sitemap reference is reported as simply absent.
  }

  const html = page.body;
  const head = html.slice(0, 200000);
  const title = head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim() ?? null;
  const description =
    head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})["']/i)?.[1] ??
    head.match(/<meta[^>]+content=["']([^"']{0,400})["'][^>]+name=["']description["']/i)?.[1] ??
    null;
  const canonical = head.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']{0,400})["']/i)?.[1] ?? null;
  const metaRobots = head.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']{0,200})["']/i)?.[1] ?? null;
  const ogTitle = head.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{0,300})["']/i)?.[1] ?? null;
  const h1Matches = html.match(/<h1[\s>]/gi) ?? [];
  const jsonLdBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const schemaTypes = Array.from(
    new Set(
      jsonLdBlocks
        .flatMap((block) => Array.from(block.matchAll(/"@type"\s*:\s*"([^"]{1,60})"/g)).map((m) => m[1])),
    ),
  ).slice(0, 20);
  const links = Array.from(html.matchAll(/<a[^>]+href=["']([^"'#][^"']{0,400})["']/gi)).map((m) => m[1]);
  let internalLinks = 0;
  let externalLinks = 0;
  for (const href of links) {
    try {
      const resolved = new URL(href, origin);
      if (resolved.origin === origin) internalLinks += 1;
      else externalLinks += 1;
    } catch {
      // Non-navigational hrefs (mailto:, tel:, javascript:) are not links.
    }
  }

  const blockedByRobots = /^\s*disallow:\s*\/\s*$/im.test(robots?.body ?? "");
  const noindex = /noindex/i.test(metaRobots ?? "");

  return Response.json(
    {
      ok: true,
      summary: redact(
        [
          `The page answered ${page.status}.`,
          noindex ? "It asks search engines not to index it." : "It does not carry a noindex instruction.",
          blockedByRobots ? "robots.txt blocks all crawling." : robots ? "robots.txt is present." : "No robots.txt was served.",
          sitemapUrlCount !== null ? `The sitemap lists ${sitemapUrlCount} URLs.` : "No readable sitemap was found.",
        ].join(" "),
      ),
      data: {
        status: page.status,
        title: title ? redact(title).slice(0, 200) : null,
        titleLength: title ? title.length : 0,
        description: description ? redact(description).slice(0, 300) : null,
        descriptionLength: description ? description.length : 0,
        canonical: canonical ? redact(canonical).slice(0, 300) : null,
        metaRobots,
        noindex,
        ogTitlePresent: Boolean(ogTitle),
        h1Count: h1Matches.length,
        schemaTypes,
        structuredDataPresent: jsonLdBlocks.length > 0,
        internalLinks,
        externalLinks,
        robotsTxtPresent: Boolean(robots && robots.status < 400),
        robotsBlocksEverything: blockedByRobots,
        sitemapUrl: sitemapUrl ? redact(sitemapUrl) : null,
        sitemapStatus,
        sitemapUrlCount,
        // Named so the agent never claims coverage it does not have.
        notCheckedHere: [
          "Google Search Console indexing status",
          "third-party SEO suite data",
          "how AI assistants answer prompts about this site",
        ],
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
  const reader = await privateReader(projectId, baseUrl);
  if (!reader.ok) return { available: false as const, code: reader.code };
  const deps = reader.deps;

  const readable: Array<{ id: string; label: string; status: string | null }> = [];
  let unauthorized = false;
  let forbidden = false;
  let reachable = false;

  for (const test of SITE_HEALTH_TESTS) {
    const outcome = await reader.get(`/wp-json/wp-site-health/v1/tests/${test}`);
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
    // An individual REST route can be disabled, nonce-protected, or denied by
    // role even after WordPress accepted the login. It is not a credential
    // verifier and must never overturn a successful login verification.
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

  const reader = await privateReader(projectId, canonicalUrl);
  if (!reader.ok) {
    return fail(
      reader.code,
      reader.code === "secret_store_unavailable"
        ? "The secure credential store isn't available, so I won't attempt a private read."
        : "I don't have usable WordPress admin access stored for this project yet.",
      false,
    );
  }
  const deps = reader.deps;

  /**
   * A refusal on one route is not a dead end. Before reporting that it cannot
   * read the plugins, the agent tries the route a human would use.
   */
  const fromAdminPage = async () => {
    const html = await reader.getAdminPage("/wp-admin/plugins.php");
    return html ? pluginsFromAdminHtml(html) : null;
  };

  const respond = (inventory: NonNullable<ReturnType<typeof normalizePlugins>>, route: "rest" | "admin_page") =>
    Response.json(
      {
        ok: true,
        summary: redact(
          `I read ${inventory.total} installed plugins (${inventory.active} active, ${inventory.inactive} inactive)${
            route === "admin_page" ? " by reading the WordPress plugins screen directly, since the REST route was blocked" : ""
          }.`,
        ),
        data: {
          total: inventory.total,
          active: inventory.active,
          inactive: inventory.inactive,
          truncated: inventory.truncated,
          plugins: inventory.plugins,
          route,
        },
      },
      { headers: corsHeaders },
    );

  const outcome = await reader.get("/wp-json/wp/v2/plugins");
  if (!outcome.ok) {
    if (outcome.kind === "unauthorized" || outcome.kind === "forbidden" || outcome.kind === "endpoint_unavailable") {
      const scraped = await fromAdminPage();
      if (scraped) {
        await deps.markVerification?.(projectId, "wordpress_admin", "verified", new Date().toISOString());
        return respond(scraped, "admin_page");
      }
    }
    if (outcome.kind === "unauthorized") {
      return fail(
        "unauthorized",
        "WordPress accepted the login, but neither the private REST route nor the plugins screen itself would give up the plugin list. The stored password has not been marked invalid.",
        false,
      );
    }
    if (outcome.kind === "forbidden") {
      return fail("forbidden", "WordPress accepted the login, but that account or a security rule does not allow the plugin-list read.", false);
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

  return respond(inventory, "rest");
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
  const elementQuery = sanitizeElementQuery(args.elementQuery);
  // Browserless is the connected service by default; a self-hosted renderer
  // overrides the address without any code change.
  const token = Deno.env.get("BROWSER_INSPECT_TOKEN") ?? null;
  const endpoint =
    Deno.env.get("BROWSER_INSPECT_ENDPOINT") ??
    (token ? "https://production-sfo.browserless.io/function" : null);
  const outcome = await runBrowserInspection(
    {
      endpoint,
      token,
    },
    { url, viewport, allowedUrl: canonicalUrl, elementQuery },
  );

  if (!outcome.ok) return fail(outcome.code, outcome.summary, outcome.retryable);
  return Response.json({ ok: true, summary: outcome.summary, data: outcome.data }, { headers: corsHeaders });
};

// ---------------------------------------------------------------------------
// Write tool implementations
// ---------------------------------------------------------------------------

/** Allowed WP REST write path pattern — must start with /wp-json/ */
const WP_REST_WRITE_PATH = /^\/wp-json\/[a-zA-Z0-9_\-/.:?=&]{1,300}$/;
const ALLOWED_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Allowed SFTP write file extensions. */
const SFTP_WRITE_EXTENSIONS = new Set([".php", ".css", ".js", ".json", ".txt", ".html", ".htm", ".htaccess"]);
const extensionOf = (path: string) => {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
};

/**
 * Authenticated WP REST API write (POST / PUT / PATCH / DELETE).
 * Credential is resolved server-side; the browser never supplies it.
 */
const restApiWrite = async (
  projectId: string,
  args: Record<string, unknown>,
  authorizedProjectId: string | null,
  canonicalUrl: string | null,
) => {
  if (!authorizedProjectId) return fail("unauthorized", "Sign in to use write tools.", false);

  const method = typeof args.method === "string" ? args.method.toUpperCase() : "";
  if (!ALLOWED_WRITE_METHODS.has(method)) {
    return fail("invalid_input", "That request needs a valid HTTP method (POST, PUT, PATCH, or DELETE).", false);
  }
  const path = typeof args.path === "string" ? args.path : "";
  if (!WP_REST_WRITE_PATH.test(path)) {
    return fail("invalid_input", "That request needs a valid /wp-json/... path.", false);
  }
  if (!canonicalUrl) return fail("invalid_input", "No canonical site URL is recorded for this project.", false);

  const cred = await resolveCredential(secretStoreDeps(), projectId, "wordpress_admin");
  if (!cred.ok) return fail(cred.code, cred.summary, false);

  let outcome: Awaited<ReturnType<typeof authenticatedGet>>;
  if (method === "POST") outcome = await authenticatedPost(canonicalUrl, path, args.body, cred.credential);
  else if (method === "PUT") outcome = await authenticatedPut(canonicalUrl, path, args.body, cred.credential);
  else if (method === "PATCH") outcome = await authenticatedPatch(canonicalUrl, path, args.body, cred.credential);
  else outcome = await authenticatedDelete(canonicalUrl, path, cred.credential);

  if (!outcome.ok) return fail(outcome.kind, `The ${method} to WordPress failed (${outcome.kind}).`, outcome.kind === "network");
  return Response.json({ ok: true, summary: `${method} to ${redact(path)} succeeded.`, data: { status: outcome.status, body: outcome.body.slice(0, 4000) } }, { headers: corsHeaders });
};

/**
 * Write a file over SFTP.
 * Path must be absolute; extension must be in the allowed set.
 */
const sftpWriteFile = async (
  projectId: string,
  args: Record<string, unknown>,
  authorizedProjectId: string | null,
) => {
  if (!authorizedProjectId) return fail("unauthorized", "Sign in to use write tools.", false);

  const path = typeof args.path === "string" ? args.path.trim() : "";
  const content = typeof args.content === "string" ? args.content : "";
  const backupFirst = args.backupFirst === true;

  if (!path.startsWith("/") || path.includes("..") || path.includes("\x00")) {
    return fail("invalid_input", "The file path must be absolute and must not contain '..' or null bytes.", false);
  }
  const ext = extensionOf(path);
  if (!SFTP_WRITE_EXTENSIONS.has(ext) && ext !== "") {
    return fail("invalid_input", `Files with extension '${ext}' are not in the write allowlist.`, false);
  }

  const access = await resolveSshAccess(secretStoreDeps(), projectId);
  if (!access.ok) return fail(access.code, access.summary, false);

  const { access: ssh } = access;
  const pin = ssh.pinnedFingerprint;
  const outcome = await denoSftpTransport().writeFile(
    {
      host: ssh.host, port: ssh.port, username: ssh.username,
      privateKey: ssh.privateKey, password: ssh.password, passphrase: ssh.passphrase,
    },
    { path, content, backupFirst },
    30_000,
    (fp) => pin ? fp === pin : true,
  );

  if (!outcome.ok) return fail(outcome.kind, `SFTP write failed: ${outcome.detail}`, outcome.kind === "timeout");
  return Response.json({
    ok: true,
    summary: `Wrote ${outcome.bytesWritten} bytes to ${redact(path)}.`,
    data: { bytesWritten: outcome.bytesWritten, hadBackup: !!outcome.backupContent, fingerprint: outcome.fingerprint },
  }, { headers: corsHeaders });
};

/**
 * Run a write WP-CLI command from the write catalog.
 * Requires authorized project; uses the same SSH transport as read WP-CLI.
 */
const runWpCliWrite = async (projectId: string, args: Record<string, unknown>) => {
  const commandId = typeof args.commandId === "string" ? args.commandId : "";
  if (!commandId) return fail("invalid_input", "That request didn't name a write operation to run.", false);

  const params: Record<string, string | undefined> = {};
  for (const name of ["plugin", "option", "value", "hook"]) {
    const value = args[name];
    if (typeof value === "string") params[name] = value;
  }

  // Reuse resolveSshAccess pattern from wpCli.ts.
  const access = await resolveSshAccess(secretStoreDeps(), projectId);
  if (!access.ok) return fail(access.code, access.summary, false);
  const { access: ssh } = access;

  const built = buildWpCliWriteCommand({ commandId, params, wpRoot: ssh.wpRoot, wpBinary: ssh.wpBinary });
  if (!built.ok) return fail(built.code, built.reason, false);

  const pin = ssh.pinnedFingerprint;
  const sshOutcome = await denoSshTransport().exec(
    { host: ssh.host, port: ssh.port, username: ssh.username, privateKey: ssh.privateKey, password: ssh.password, passphrase: ssh.passphrase },
    built.command,
    30_000,
    (fp) => pin ? fp === pin : true,
  );

  if (!sshOutcome.ok) return fail(sshOutcome.kind, `WP-CLI write failed: ${sshOutcome.detail}`, sshOutcome.kind === "timeout");
  const out = sshOutcome.stdout.slice(0, 2000);
  return Response.json({ ok: true, summary: `Ran '${commandId}' successfully.`, data: { stdout: redact(out), exitCode: sshOutcome.exitCode } }, { headers: corsHeaders });
};

/**
 * Purge site cache.
 * Tries LiteSpeed cache purge endpoint first, falls back to WP-CLI cache.flush.
 */
const purgeCache = async (
  projectId: string,
  canonicalUrl: string | null,
  authorizedProjectId: string | null,
) => {
  if (!canonicalUrl) return fail("invalid_input", "No canonical site URL is recorded for this project.", false);

  // 1. Try LiteSpeed HTTP purge.
  try {
    const purgeUrl = new URL("/__lscache/purge", canonicalUrl).toString();
    const res = await fetch(purgeUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (res.ok || res.headers.get("x-litespeed-cache") || res.headers.get("x-litespeed-purge")) {
      await res.body?.cancel().catch(() => undefined);
      return Response.json({ ok: true, summary: "LiteSpeed cache purged via HTTP endpoint.", data: { method: "litespeed_http" } }, { headers: corsHeaders });
    }
    await res.body?.cancel().catch(() => undefined);
  } catch {
    // LiteSpeed endpoint not available — fall through.
  }

  // 2. Try WP-CLI cache flush.
  const wpcliResult = await runWpCliWrite(projectId, { commandId: "cache.flush" });
  const wpcliBody = await wpcliResult.json().catch(() => ({ ok: false })) as { ok: boolean };
  if (wpcliBody.ok) {
    return Response.json({ ok: true, summary: "WordPress object cache flushed via WP-CLI.", data: { method: "wp_cli" } }, { headers: corsHeaders });
  }

  return fail("not_implemented", "No cache purge method succeeded for this site.", true);
};

/**
 * Activate / deactivate / trash a WPCode snippet by ID, or create a new one.
 */
const wpCodeSnippet = async (
  projectId: string,
  args: Record<string, unknown>,
  canonicalUrl: string | null,
  authorizedProjectId: string | null,
) => {
  if (!authorizedProjectId) return fail("unauthorized", "Sign in to use write tools.", false);
  if (!canonicalUrl) return fail("invalid_input", "No canonical site URL is recorded for this project.", false);

  const action = typeof args.action === "string" && ["activate", "deactivate", "trash", "create"].includes(args.action)
    ? (args.action as "activate" | "deactivate" | "trash" | "create")
    : null;
  if (!action) return fail("invalid_input", "That request needs an action: activate, deactivate, trash, or create.", false);

  const cred = await resolveCredential(secretStoreDeps(), projectId, "wordpress_admin");
  if (!cred.ok) return fail(cred.code, cred.summary, false);

  if (action === "create") {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const code = typeof args.code === "string" ? args.code : "";
    const codeType = args.codeType === "php" ? "php" : "js";
    const location = args.location === "php_head" || args.location === "php_body" ? args.location : "footer";
    const activate = args.activate !== false;
    if (!title) return fail("invalid_input", "A new snippet needs a short title.", false);
    if (code.length < 5) return fail("invalid_input", "A new snippet needs its code.", false);
    if (code.length > 8000) return fail("invalid_input", "That snippet is too long for a safe create (8 KB limit).", false);
    if (codeType === "js" && location !== "footer") {
      return fail("invalid_input", "JavaScript snippets can only go in the footer location.", false);
    }
    if (codeType === "php" && !/<\?php/.test(code)) {
      return fail("invalid_input", "PHP snippets must start with an opening <?php tag.", false);
    }
    const outcome = await wpCodeSnippetCreate(
      canonicalUrl,
      { title, code, codeType, location, activate },
      cred.credential,
    );
    if (!outcome.ok) return fail(outcome.kind, `WPCode snippet create failed (${outcome.kind}).`, outcome.kind === "network");
    return Response.json({
      ok: true,
      summary: `Created WPCode snippet "${title}"${activate ? " and activated it" : ""}.`,
      data: { action: "create", title, codeType, location, active: activate, status: outcome.status },
    }, { headers: corsHeaders });
  }

  const snippetId = typeof args.snippetId === "number" ? args.snippetId : parseInt(String(args.snippetId ?? ""), 10);
  if (!Number.isInteger(snippetId) || snippetId <= 0) {
    return fail("invalid_input", "That request needs a valid WPCode snippet ID (positive integer).", false);
  }

  const outcome = await wpCodeSnippetAction(canonicalUrl, snippetId, action, cred.credential);
  if (!outcome.ok) return fail(outcome.kind, `WPCode snippet ${action} failed (${outcome.kind}).`, outcome.kind === "network");
  return Response.json({ ok: true, summary: `WPCode snippet #${snippetId} ${action}d.`, data: { snippetId, action, status: outcome.status } }, { headers: corsHeaders });
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
    // A real browser is a real cost and a real outbound request. It only ever
    // runs for a project the caller has proven they can reach.
    if (toolId === "browser.inspect_page_readonly" && !authorizedProjectId) {
      return fail("unauthorized", AUTH_FAIL_SUMMARY.unauthorized, false);
    }
  }

  // ---- Knowledge base (cross-project incident library) ------------------
  // The table is service-role only (RLS, no anon policies), so the browser
  // reaches it exclusively through this authorized boundary. Reads seed the
  // reasoning digest; writes happen only at a verified sufficient_evidence
  // stop, distilled from the run's own evidence.
  if (mode === "kb_list" || mode === "kb_upsert") {
    const authz = await authorizeProject(authorization, projectId, authzDeps());
    if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code], false);
    const service = serviceClient();

    if (mode === "kb_list") {
      const taskType = typeof args.taskType === "string" && args.taskType ? args.taskType : null;
      let query = service
        .from("knowledge_base_entries")
        .select("*")
        .order("last_confirmed_at", { ascending: false })
        .limit(50);
      if (taskType) query = query.eq("task_type", taskType);
      const { data, error } = await query;
      if (error) return fail("kb_read_failed", "I couldn't read the incident library just now.", true);
      return Response.json(
        {
          ok: true,
          summary: "Read the incident library.",
          data: { entries: data ?? [] },
        },
        { headers: corsHeaders },
      );
    }

    // kb_upsert: match on task_type + normalized symptom_pattern. On match,
    // increment project_count, refresh last_confirmed_at, keep the longer
    // resolution. No client-supplied ids, no scope escalation.
    const taskType = typeof args.taskType === "string" ? args.taskType.trim() : "";
    const symptomPattern = typeof args.symptomPattern === "string" ? args.symptomPattern.trim() : "";
    const resolution = typeof args.resolution === "string" ? args.resolution.trim() : "";
    if (!taskType || !symptomPattern || !resolution) {
      return fail("invalid_input", "That knowledge-base entry was missing required fields.", false);
    }
    const evidenceSignals = Array.isArray(args.evidenceSignals)
      ? args.evidenceSignals.filter((s): s is string => typeof s === "string").slice(0, 5)
      : [];
    const toolsUsed = Array.isArray(args.toolsUsed)
      ? args.toolsUsed.filter((s): s is string => typeof s === "string").slice(0, 20)
      : [];
    const hostContext = typeof args.hostContext === "string" && args.hostContext ? args.hostContext : null;
    const normalized = symptomPattern.toLowerCase();

    const existing = await service
      .from("knowledge_base_entries")
      .select("id, symptom_pattern, resolution, project_count")
      .eq("task_type", taskType)
      .order("created_at", { ascending: false })
      .limit(200);
    if (existing.error) {
      return fail("kb_write_failed", "I couldn't reach the incident library just now.", true);
    }
    const match = (existing.data ?? []).find(
      (row) => String(row.symptom_pattern ?? "").trim().toLowerCase() === normalized,
    );

    if (match) {
      const { error: updateError } = await service.from("knowledge_base_entries").update({
        project_count: Number(match.project_count ?? 1) + 1,
        last_confirmed_at: new Date().toISOString(),
        ...(resolution.length > String(match.resolution ?? "").length ? { resolution } : {}),
        evidence_signals: evidenceSignals.length > 0 ? evidenceSignals : undefined,
        tools_used: toolsUsed.length > 0 ? toolsUsed : undefined,
        host_context: hostContext ?? undefined,
      }).eq("id", match.id);
      if (updateError) return fail("kb_write_failed", "I couldn't update the incident library.", true);
      return Response.json({ ok: true, summary: "Reinforced a known incident pattern.", data: {} }, { headers: corsHeaders });
    }

    const { error: insertError } = await service.from("knowledge_base_entries").insert({
      task_type: taskType,
      symptom_pattern: symptomPattern,
      resolution,
      evidence_signals: evidenceSignals,
      tools_used: toolsUsed,
      host_context: hostContext,
    });
    if (insertError) return fail("kb_write_failed", "I couldn't save to the incident library.", true);
    return Response.json({ ok: true, summary: "Learned a new incident pattern.", data: {} }, { headers: corsHeaders });
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
        data: {
          // Password-based SFTP reaches the same server over the same SSH
          // transport, so it satisfies the "ssh" capability the tools ask for.
          capabilities: withServerCapability(truth.stored),
          verifiedCapabilities: withServerCapability(truth.verified),
        },
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
    case "public_http.inspect_seo_surface":
      if (!clientUrl && !canonicalUrl) {
        return fail("invalid_input", "That request was missing the site address.", false);
      }
      return await inspectSeoSurface(canonicalUrl ?? clientUrl);
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
    // --- Write tools ---
    case "wordpress.rest_api_write":
      return await restApiWrite(wpProjectId, args, authorizedProjectId, canonicalUrl);
    case "wordpress.sftp_write_file":
      return await sftpWriteFile(wpProjectId, args, authorizedProjectId);
    case "wordpress.run_wp_cli_write":
      return await runWpCliWrite(wpProjectId, args);
    case "wordpress.purge_cache":
      return await purgeCache(wpProjectId, canonicalUrl, authorizedProjectId);
    case "wordpress.wpcode_snippet":
      return await wpCodeSnippet(wpProjectId, args, canonicalUrl, authorizedProjectId);
    default:
      return fail("not_implemented", "That capability is not enabled yet.", false);
  }
});
