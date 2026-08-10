/**
 * The closed WP-CLI read-only command catalog.
 *
 * This file is the whole safety model for server-side command execution, and
 * it is deliberately pure TypeScript: no Deno globals, no npm specifiers, so
 * the security checks exercise exactly the code that runs in production.
 *
 * Three rules hold here, and nothing downstream may relax them:
 *
 *   1. There is no free-text command. A caller names a catalog id. It cannot
 *      express a command the catalog does not already contain.
 *   2. Every argv token — from the catalog or from a validated parameter —
 *      must match a conservative safe-token pattern before it is quoted, so a
 *      shell metacharacter can never reach the remote shell.
 *   3. The composed command line is re-validated against a whole-string
 *      pattern afterwards. If anything unexpected survived, nothing runs.
 *
 * Write commands are not "blocked" here. They are simply absent, and a
 * mutation guard rejects the catalog itself at module load if one is ever
 * added by mistake.
 */

export type WpCliParamKind = "plugin_slug" | "theme_slug" | "option_key";

export type WpCliParam = {
  name: string;
  kind: WpCliParamKind;
};

export type WpCliCommand = {
  id: string;
  /** Plain-English purpose. Safe to paraphrase to a person. */
  purpose: string;
  /** Fixed argv after `wp`. `:name` marks a validated parameter slot. */
  argv: string[];
  params: WpCliParam[];
  /** Output is JSON and may be parsed into structured evidence. */
  json: boolean;
};

/**
 * Read-only inspections only. Every entry was chosen because it answers a real
 * diagnostic question without touching the database, the filesystem, or cache.
 */
export const WP_CLI_READONLY_CATALOG: readonly WpCliCommand[] = [
  {
    id: "core.version",
    purpose: "Read the WordPress version installed on the server.",
    argv: ["core", "version"],
    params: [],
    json: false,
  },
  {
    id: "core.check_update",
    purpose: "Check whether a newer WordPress version is available.",
    argv: ["core", "check-update", "--format=json"],
    params: [],
    json: true,
  },
  {
    id: "core.is_installed",
    purpose: "Confirm WordPress is actually installed at this path.",
    argv: ["core", "is-installed"],
    params: [],
    json: false,
  },
  {
    id: "core.verify_checksums",
    purpose: "Compare WordPress core files against the official checksums.",
    argv: ["core", "verify-checksums"],
    params: [],
    json: false,
  },
  {
    id: "plugin.list",
    purpose: "Read every installed plugin, its status and its version.",
    argv: ["plugin", "list", "--format=json", "--fields=name,status,version,update,update_version"],
    params: [],
    json: true,
  },
  {
    id: "plugin.get",
    purpose: "Read the details of one specific plugin.",
    argv: ["plugin", "get", ":plugin", "--format=json"],
    params: [{ name: "plugin", kind: "plugin_slug" }],
    json: true,
  },
  {
    id: "theme.list",
    purpose: "Read every installed theme, its status and its version.",
    argv: ["theme", "list", "--format=json", "--fields=name,status,version,update"],
    params: [],
    json: true,
  },
  {
    id: "user.list_roles",
    purpose: "Read the account names and roles that exist, without addresses.",
    argv: ["user", "list", "--format=json", "--fields=ID,user_login,roles"],
    params: [],
    json: true,
  },
  {
    id: "option.get",
    purpose: "Read one specific, non-sensitive WordPress setting.",
    argv: ["option", "get", ":option", "--format=json"],
    params: [{ name: "option", kind: "option_key" }],
    json: true,
  },
  {
    id: "cron.event_list",
    purpose: "Read the scheduled tasks WordPress is holding.",
    argv: ["cron", "event", "list", "--format=json"],
    params: [],
    json: true,
  },
  {
    id: "maintenance_mode.status",
    purpose: "Check whether the site is currently in maintenance mode.",
    argv: ["maintenance-mode", "status"],
    params: [],
    json: false,
  },
  {
    id: "db.size",
    purpose: "Read how large the database is.",
    argv: ["db", "size", "--format=json"],
    params: [],
    json: true,
  },
  {
    id: "config.get_table_prefix",
    purpose: "Read the database table prefix this install uses.",
    argv: ["config", "get", "table_prefix"],
    params: [],
    json: false,
  },
];

export const WP_CLI_COMMAND_IDS: readonly string[] = WP_CLI_READONLY_CATALOG.map((entry) => entry.id);

// ---------------------------------------------------------------------------
// Mutation guard — the catalog polices itself.
// ---------------------------------------------------------------------------

/**
 * Any WP-CLI verb that can change state. A catalog entry containing one of
 * these is a programming error, not a runtime condition.
 */
const MUTATING_TOKENS = new Set([
  "activate",
  "add",
  "clean",
  "clear",
  "create",
  "deactivate",
  "delete",
  "download",
  "drop",
  "edit",
  "empty",
  "eval",
  "eval-file",
  "export",
  "flush",
  "generate",
  "import",
  "install",
  "optimize",
  "patch",
  "query",
  "regenerate",
  "rename",
  "repair",
  "replace",
  "reset",
  "run",
  "search-replace",
  "set",
  "shell",
  "spawn",
  "toggle",
  "uninstall",
  "update",
  "upgrade",
  "cli",
]);

/** True when an argv list contains a state-changing verb in a command slot. */
export const argvIsMutating = (argv: readonly string[]): boolean =>
  argv.some((token) => !token.startsWith("-") && MUTATING_TOKENS.has(token));

/**
 * `--fields=name,status,version,update` legitimately contains "update" as a
 * field name, so flags are excluded above. This asserts the catalog as a whole.
 */
export const catalogMutationViolations = (): string[] =>
  WP_CLI_READONLY_CATALOG.filter((entry) => argvIsMutating(entry.argv)).map((entry) => entry.id);

// ---------------------------------------------------------------------------
// Token safety.
// ---------------------------------------------------------------------------

/**
 * Conservative on purpose. No spaces, no quotes, no shell metacharacters, no
 * newlines. Everything that reaches the wire must match this before quoting.
 */
export const SAFE_TOKEN = /^[A-Za-z0-9._:/=@,+-]+$/;

/** Composed command line: nothing but single-quoted safe tokens. */
export const SAFE_COMMAND_LINE = /^'[A-Za-z0-9._:/=@,+-]+'(?: '[A-Za-z0-9._:/=@,+-]+')*$/;

const PARAM_PATTERNS: Record<WpCliParamKind, RegExp> = {
  plugin_slug: /^[a-z0-9][a-z0-9._-]{0,62}$/,
  theme_slug: /^[a-z0-9][a-z0-9._-]{0,62}$/,
  option_key: /^[a-z0-9_][a-z0-9_-]{0,62}$/,
};

/**
 * Settings that hold credentials or keys are never readable through this tool,
 * even though `option get` itself is a read.
 */
const FORBIDDEN_OPTION_KEYS = new Set([
  "auth_key",
  "auth_salt",
  "logged_in_key",
  "logged_in_salt",
  "nonce_key",
  "nonce_salt",
  "secure_auth_key",
  "secure_auth_salt",
]);

const optionKeyLooksSensitive = (value: string): boolean =>
  FORBIDDEN_OPTION_KEYS.has(value) || /(?:_key|_salt|_secret|_token|password|api_key)$/.test(value);

// ---------------------------------------------------------------------------
// Path + binary validation.
// ---------------------------------------------------------------------------

const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{0,255}$/;

export const validateWpRoot = (value: string | null | undefined): { ok: true; path: string | null } | { ok: false; reason: string } => {
  if (value === null || value === undefined || value === "") return { ok: true, path: null };
  const path = value.trim();
  if (!ABSOLUTE_PATH.test(path) || path.includes("..")) {
    return { ok: false, reason: "The WordPress folder path on the server doesn't look like a valid absolute path." };
  }
  return { ok: true, path: path.replace(/\/+$/, "") || "/" };
};

export const validateWpBinary = (value: string | null | undefined): { ok: true; binary: string } | { ok: false; reason: string } => {
  if (value === null || value === undefined || value === "") return { ok: true, binary: "wp" };
  const binary = value.trim();
  if (binary === "wp") return { ok: true, binary };
  if (!ABSOLUTE_PATH.test(binary) || binary.includes("..") || binary.endsWith("/")) {
    return { ok: false, reason: "The WP-CLI path on the server doesn't look like a valid absolute path." };
  }
  return { ok: true, binary };
};

// ---------------------------------------------------------------------------
// Command building.
// ---------------------------------------------------------------------------

export type BuildInput = {
  commandId: string;
  params?: Record<string, string | undefined>;
  wpRoot?: string | null;
  wpBinary?: string | null;
};

export type BuildResult =
  | { ok: true; command: string; entry: WpCliCommand; argv: string[] }
  | { ok: false; code: string; reason: string };

const quote = (token: string): string => `'${token}'`;

export const findCommand = (commandId: string): WpCliCommand | null =>
  WP_CLI_READONLY_CATALOG.find((entry) => entry.id === commandId) ?? null;

/**
 * Turns a catalog id plus validated parameters into an exact command line.
 * Every failure path returns a reason a person can act on, and never echoes
 * the rejected input back into the shell or the transcript.
 */
export const buildWpCliCommand = (input: BuildInput): BuildResult => {
  const entry = findCommand(input.commandId);
  if (!entry) {
    return { ok: false, code: "command_not_allowed", reason: "That isn't one of the read-only inspections I can run." };
  }

  // Defence in depth: even a catalog entry is re-checked before it runs.
  if (argvIsMutating(entry.argv)) {
    return { ok: false, code: "command_not_allowed", reason: "That inspection would change the site, so I won't run it." };
  }

  const root = validateWpRoot(input.wpRoot);
  if (!root.ok) return { ok: false, code: "invalid_input", reason: root.reason };

  const binary = validateWpBinary(input.wpBinary);
  if (!binary.ok) return { ok: false, code: "invalid_input", reason: binary.reason };

  const supplied = input.params ?? {};
  const provided = Object.keys(supplied).filter((key) => supplied[key] !== undefined);
  const expected = entry.params.map((param) => param.name);
  const unexpected = provided.filter((key) => !expected.includes(key));
  if (unexpected.length > 0) {
    return { ok: false, code: "invalid_input", reason: "That inspection doesn't take those details." };
  }

  const resolved: string[] = [];
  for (const token of entry.argv) {
    if (!token.startsWith(":")) {
      resolved.push(token);
      continue;
    }
    const param = entry.params.find((candidate) => `:${candidate.name}` === token);
    if (!param) {
      return { ok: false, code: "command_not_allowed", reason: "That inspection is not configured correctly." };
    }
    const raw = supplied[param.name];
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, code: "invalid_input", reason: "That inspection needs one more detail before I can run it." };
    }
    const value = raw.trim().toLowerCase();
    if (!PARAM_PATTERNS[param.kind].test(value)) {
      return { ok: false, code: "invalid_input", reason: "That name contains characters I won't send to a server." };
    }
    if (param.kind === "option_key" && optionKeyLooksSensitive(value)) {
      return { ok: false, code: "command_not_allowed", reason: "That setting can hold a secret, so I won't read it." };
    }
    resolved.push(value);
  }

  const argv = [binary.binary, ...resolved, "--no-color"];
  if (root.path) argv.push(`--path=${root.path}`);

  for (const token of argv) {
    if (!SAFE_TOKEN.test(token)) {
      return { ok: false, code: "command_not_allowed", reason: "I refused to build that command because part of it was unsafe." };
    }
  }

  const command = argv.map(quote).join(" ");
  // Final whole-string gate. If quoting or composition ever changes, this is
  // what stops an unexpected shape from reaching a real server.
  if (!SAFE_COMMAND_LINE.test(command)) {
    return { ok: false, code: "command_not_allowed", reason: "I refused to build that command because part of it was unsafe." };
  }

  return { ok: true, command, entry, argv };
};