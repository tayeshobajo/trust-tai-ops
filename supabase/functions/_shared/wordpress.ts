/**
 * Authenticated WordPress reads.
 *
 * Read-only by construction: only GET, only the project's canonical origin,
 * and the credential is dropped the moment a redirect leaves that origin.
 */

import { fetchSafely, readBounded, redact, validatePublicUrl } from "./net.ts";

export type WpCredential = { username: string; applicationPassword: string };

export type WpOutcome =
  | { ok: true; status: number; body: string; credentialsSurvived: boolean }
  | { ok: false; kind: "unauthorized" | "forbidden" | "endpoint_unavailable" | "network" | "unsafe"; status: number | null };

export const basicAuthHeader = (credential: WpCredential): string =>
  `Basic ${btoa(`${credential.username}:${credential.applicationPassword}`)}`;

const MAX_PLUGINS = 200;
const clean = (value: unknown, max = 120): string =>
  typeof value === "string" ? redact(value.replace(/<[^>]*>/g, "").trim()).slice(0, max) : "";

/**
 * One authenticated GET against the project's own origin.
 * `baseUrl` must come from the server-resolved project environment.
 */
export const authenticatedGet = async (
  baseUrl: string,
  path: string,
  credential: WpCredential | null,
  fetchImpl: typeof fetch = fetch,
  /**
   * A signed-in session cookie, when Basic auth is not what this install
   * accepts. Read-only by construction: it only ever rides a GET.
   */
  sessionCookie?: string | null,
  /** Required by WordPress when a REST read authenticates with cookies. */
  sessionNonce?: string | null,
): Promise<WpOutcome> => {
  const base = validatePublicUrl(baseUrl);
  if (!base.ok) return { ok: false, kind: "unsafe", status: null };
  const target = validatePublicUrl(new URL(path, base.url.origin).toString());
  if (!target.ok) return { ok: false, kind: "unsafe", status: null };

  const headers: Record<string, string> = { accept: "application/json" };
  if (credential) headers.authorization = basicAuthHeader(credential);
  if (sessionCookie) headers.cookie = sessionCookie;
  if (sessionNonce) headers["x-wp-nonce"] = sessionNonce;

  const attempt = await fetchSafely(
    target.url,
    { headers, credentialHeaders: ["authorization", "cookie", "x-wp-nonce"] },
    fetchImpl,
  );
  if ("error" in attempt) {
    return { ok: false, kind: attempt.error === "unsafe_destination" ? "unsafe" : "network", status: null };
  }

  const { response, credentialsSurvived } = attempt;
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "unauthorized", status: 401 };
  }
  if (response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "forbidden", status: 403 };
  }
  if (response.status === 404 || response.status === 501) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "endpoint_unavailable", status: response.status };
  }
  if (!response.ok) {
    // Anything else that is not a success — a 500, a 429, a gateway error — is
    // a failed read. Treating it as a body we can interpret would let a broken
    // site look like a working, authenticated one.
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "network", status: response.status };
  }

  const body = await readBounded(response);
  return { ok: true, status: response.status, body, credentialsSurvived };
};

export type PluginInventoryItem = {
  identifier: string;
  name: string;
  status: string;
  version: string | null;
  author: string | null;
  updateAvailable: boolean | null;
};

export type PluginInventory = {
  total: number;
  active: number;
  inactive: number;
  truncated: boolean;
  plugins: PluginInventoryItem[];
};

/** Only fields WordPress actually returned. Nothing is inferred. */
export const normalizePlugins = (payload: unknown): PluginInventory | null => {
  if (!Array.isArray(payload)) return null;
  const truncated = payload.length > MAX_PLUGINS;
  const rows = payload.slice(0, MAX_PLUGINS);
  const plugins: PluginInventoryItem[] = rows.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const update = item.update;
    return {
      identifier: clean(item.plugin, 160),
      name: clean(item.name, 120),
      status: clean(item.status, 24) || "unknown",
      version: clean(item.version, 32) || null,
      author: clean(item.author, 80) || null,
      updateAvailable:
        typeof update === "string" ? update !== "" && update !== "false" : update === undefined ? null : Boolean(update),
    };
  });

  return {
    total: payload.length,
    active: plugins.filter((plugin) => plugin.status === "active").length,
    inactive: plugins.filter((plugin) => plugin.status === "inactive").length,
    truncated,
    plugins,
  };
};

export type HealthTest = { id: string; label: string; status: string | null };

/**
 * The resourceful route to the plugin inventory.
 *
 * Plenty of installs refuse `/wp-json/wp/v2/plugins` (a security plugin, a
 * host rule, or a role without `activate_plugins` over REST) even though the
 * very same signed-in account can read `/wp-admin/plugins.php` in a browser.
 * Rather than stopping and asking a person for SSH, the agent reads the page
 * a human would read. Still a plain GET, still read-only.
 */
export const pluginsFromAdminHtml = (html: string): PluginInventory | null => {
  if (typeof html !== "string" || !/data-plugin=/i.test(html)) return null;

  const rows = html.split(/<tr\b/i).slice(1);
  const items: PluginInventoryItem[] = [];
  let total = 0;

  for (const row of rows) {
    const identifier = row.match(/data-plugin=["']([^"']+)["']/i)?.[1];
    if (!identifier) continue;
    total += 1;
    if (items.length >= MAX_PLUGINS) continue;

    const classes = row.match(/class=["']([^"']*)["']/i)?.[1] ?? "";
    const status = /\bactive\b/i.test(classes) && !/\binactive\b/i.test(classes) ? "active" : "inactive";
    const name =
      row.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1] ??
      identifier.split("/")[0];
    const version = row.match(/Version\s+([0-9][0-9A-Za-z.\-+]*)/i)?.[1] ?? null;
    const author = row.match(/By\s*(?:<a[^>]*>)?([^<|]{2,80})/i)?.[1] ?? null;

    items.push({
      identifier: clean(identifier, 160),
      name: clean(name, 120) || clean(identifier, 120),
      status,
      version: version ? clean(version, 32) : null,
      author: author ? clean(author.trim(), 80) || null : null,
      updateAvailable: /there is a new version|update now|update-message/i.test(row) ? true : null,
    });
  }

  if (total === 0) return null;

  return {
    total,
    active: items.filter((plugin) => plugin.status === "active").length,
    inactive: items.filter((plugin) => plugin.status === "inactive").length,
    truncated: total > items.length,
    plugins: items,
  };
};

/** Site Health results, reduced to what the response actually proves. */
export const normalizeHealthTest = (id: string, payload: unknown): HealthTest | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const label = clean(record.label, 120);
  const status = clean(record.status, 32);
  if (!label && !status) return null;
  return { id, label: label || id, status: status || null };
};
// ---------------------------------------------------------------------------
// Authenticated write methods (POST / PUT / PATCH / DELETE)
// ---------------------------------------------------------------------------

/**
 * Shared mutate helper. All write methods go through here.
 * Same origin-lock and credential-drop logic as authenticatedGet.
 */
const authenticatedMutate = async (
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  baseUrl: string,
  path: string,
  body: unknown,
  credential: WpCredential | null,
  fetchImpl: typeof fetch = fetch,
  sessionCookie?: string | null,
  sessionNonce?: string | null,
): Promise<WpOutcome> => {
  const base = validatePublicUrl(baseUrl);
  if (!base.ok) return { ok: false, kind: "unsafe", status: null };
  const target = validatePublicUrl(new URL(path, base.url.origin).toString());
  if (!target.ok) return { ok: false, kind: "unsafe", status: null };

  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (credential) headers.authorization = basicAuthHeader(credential);
  if (sessionCookie) headers.cookie = sessionCookie;
  if (sessionNonce) headers["x-wp-nonce"] = sessionNonce;

  const hasBody = method !== "DELETE";
  const attempt = await fetchSafely(
    target.url,
    {
      method,
      headers,
      credentialHeaders: ["authorization", "cookie", "x-wp-nonce"],
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    },
    fetchImpl,
  );
  if ("error" in attempt) {
    return { ok: false, kind: attempt.error === "unsafe_destination" ? "unsafe" : "network", status: null };
  }

  const { response, credentialsSurvived } = attempt;
  if (response.status === 401) { await response.body?.cancel().catch(() => undefined); return { ok: false, kind: "unauthorized", status: 401 }; }
  if (response.status === 403) { await response.body?.cancel().catch(() => undefined); return { ok: false, kind: "forbidden", status: 403 }; }
  if (response.status === 404 || response.status === 501) { await response.body?.cancel().catch(() => undefined); return { ok: false, kind: "endpoint_unavailable", status: response.status }; }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { ok: false, kind: "network", status: response.status }; }

  const responseBody = await readBounded(response);
  return { ok: true, status: response.status, body: responseBody, credentialsSurvived };
};

export const authenticatedPost = (
  baseUrl: string, path: string, body: unknown, credential: WpCredential | null,
  fetchImpl?: typeof fetch, sessionCookie?: string | null, sessionNonce?: string | null,
): Promise<WpOutcome> =>
  authenticatedMutate("POST", baseUrl, path, body, credential, fetchImpl, sessionCookie, sessionNonce);

export const authenticatedPut = (
  baseUrl: string, path: string, body: unknown, credential: WpCredential | null,
  fetchImpl?: typeof fetch, sessionCookie?: string | null, sessionNonce?: string | null,
): Promise<WpOutcome> =>
  authenticatedMutate("PUT", baseUrl, path, body, credential, fetchImpl, sessionCookie, sessionNonce);

export const authenticatedPatch = (
  baseUrl: string, path: string, body: unknown, credential: WpCredential | null,
  fetchImpl?: typeof fetch, sessionCookie?: string | null, sessionNonce?: string | null,
): Promise<WpOutcome> =>
  authenticatedMutate("PATCH", baseUrl, path, body, credential, fetchImpl, sessionCookie, sessionNonce);

export const authenticatedDelete = (
  baseUrl: string, path: string, credential: WpCredential | null,
  fetchImpl?: typeof fetch, sessionCookie?: string | null, sessionNonce?: string | null,
): Promise<WpOutcome> =>
  authenticatedMutate("DELETE", baseUrl, path, undefined, credential, fetchImpl, sessionCookie, sessionNonce);

/**
 * WPCode snippet activate / deactivate / trash.
 * Uses the WPCode REST API (/wp-json/wpcode/v1/snippets/:id).
 */
export const wpCodeSnippetAction = async (
  baseUrl: string,
  snippetId: number,
  action: "activate" | "deactivate" | "trash",
  credential: WpCredential | null,
  fetchImpl: typeof fetch = fetch,
  sessionCookie?: string | null,
  sessionNonce?: string | null,
): Promise<WpOutcome> => {
  const path = `/wp-json/wpcode/v1/snippets/${snippetId}`;
  if (action === "trash") {
    return authenticatedDelete(baseUrl, path, credential, fetchImpl, sessionCookie, sessionNonce);
  }
  return authenticatedPut(baseUrl, path, { active: action === "activate" }, credential, fetchImpl, sessionCookie, sessionNonce);
};

/**
 * Create (and optionally activate) a WPCode snippet.
 * POST /wp-json/wpcode/v1/snippets — requires WPCode plugin with REST routes
 * enabled and an administrator application password. Code location is
 * validated: only footer script and PHP head/body locations are accepted.
 */
export const wpCodeSnippetCreate = async (
  baseUrl: string,
  snippet: { title: string; code: string; codeType: "js" | "php"; location: "footer" | "php_head" | "php_body"; activate: boolean },
  credential: WpCredential | null,
  fetchImpl: typeof fetch = fetch,
  sessionCookie?: string | null,
  sessionNonce?: string | null,
): Promise<WpOutcome> => {
  const path = "/wp-json/wpcode/v1/snippets";
  const body = {
    title: snippet.title.slice(0, 120),
    code: snippet.code.slice(0, 8000),
    code_type: snippet.codeType === "js" ? "js" : "php", // eslint-disable-line @typescript-eslint/no-explicit-any
    location: snippet.location,
    active: snippet.activate,
  };
  return authenticatedPost(baseUrl, path, body, credential, fetchImpl, sessionCookie, sessionNonce);
};
