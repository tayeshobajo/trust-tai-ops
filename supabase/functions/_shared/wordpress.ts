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
): Promise<WpOutcome> => {
  const base = validatePublicUrl(baseUrl);
  if (!base.ok) return { ok: false, kind: "unsafe", status: null };
  const target = validatePublicUrl(new URL(path, base.url.origin).toString());
  if (!target.ok) return { ok: false, kind: "unsafe", status: null };

  const headers: Record<string, string> = { accept: "application/json" };
  if (credential) headers.authorization = basicAuthHeader(credential);

  const attempt = await fetchSafely(
    target.url,
    { headers, credentialHeaders: ["authorization"] },
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

/** Site Health results, reduced to what the response actually proves. */
export const normalizeHealthTest = (id: string, payload: unknown): HealthTest | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const label = clean(record.label, 120);
  const status = clean(record.status, 32);
  if (!label && !status) return null;
  return { id, label: label || id, status: status || null };
};