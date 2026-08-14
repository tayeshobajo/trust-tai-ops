/**
 * The closed WP-CLI write command catalog.
 *
 * Separate from the read catalog by design — the read catalog has a mutation
 * guard that rejects any write verb at module load. This file is the write
 * complement: every entry is an intentional, named state-change that the
 * orchestrator may propose ONLY after sufficient_evidence is reached.
 *
 * The same three safety rules from the read catalog apply here:
 *   1. No free-text command. Caller names a catalog id.
 *   2. Every argv token must match SAFE_TOKEN before it is quoted.
 *   3. The composed command line is re-validated against SAFE_COMMAND_LINE.
 *
 * Additional write-catalog rule:
 *   4. requiresConfirmation=true entries must never be dispatched without an
 *      explicit approved_proposal row from a human approver.
 */

import { SAFE_TOKEN, SAFE_COMMAND_LINE, type WpCliParamKind, validateWpRoot, validateWpBinary } from "./wpCliCatalog.ts";

// ---------------------------------------------------------------------------
// Extended param kinds for write commands
// ---------------------------------------------------------------------------

export type WpCliWriteParamKind = WpCliParamKind | "hook_name" | "option_value" | "plugin_slug" | "theme_slug";

export type WpCliWriteParam = {
  name: string;
  kind: WpCliWriteParamKind;
};

export type WpCliWriteCommand = {
  id: string;
  /** Plain-English purpose. Safe to paraphrase to a person. */
  purpose: string;
  /** Fixed argv after `wp`. `:name` marks a validated parameter slot. */
  argv: string[];
  params: WpCliWriteParam[];
  /** Output is JSON and may be parsed into structured evidence. */
  json: boolean;
  /**
   * If true, this command must have an approved_proposal from a human before
   * the orchestrator may dispatch it. Used for irreversible or high-impact ops.
   */
  requiresConfirmation: boolean;
};

// ---------------------------------------------------------------------------
// Write catalog
// ---------------------------------------------------------------------------

export const WP_CLI_WRITE_CATALOG: readonly WpCliWriteCommand[] = [
  {
    id: "plugin.activate",
    purpose: "Activate a specific plugin.",
    argv: ["plugin", "activate", ":plugin"],
    params: [{ name: "plugin", kind: "plugin_slug" }],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "plugin.deactivate",
    purpose: "Deactivate a specific plugin.",
    argv: ["plugin", "deactivate", ":plugin"],
    params: [{ name: "plugin", kind: "plugin_slug" }],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "plugin.update",
    purpose: "Update a specific plugin to its latest version.",
    argv: ["plugin", "update", ":plugin"],
    params: [{ name: "plugin", kind: "plugin_slug" }],
    json: false,
    requiresConfirmation: true, // irreversible version change
  },
  {
    id: "cache.flush",
    purpose: "Flush the WordPress object cache.",
    argv: ["cache", "flush"],
    params: [],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "rewrite.flush",
    purpose: "Flush WordPress rewrite rules (fixes permalink 404s).",
    argv: ["rewrite", "flush"],
    params: [],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "cron.run_event",
    purpose: "Manually trigger a specific scheduled cron event hook.",
    argv: ["cron", "event", "run", ":hook"],
    params: [{ name: "hook", kind: "hook_name" }],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "maintenance.enable",
    purpose: "Enable WordPress maintenance mode.",
    argv: ["maintenance-mode", "activate"],
    params: [],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "maintenance.disable",
    purpose: "Disable WordPress maintenance mode.",
    argv: ["maintenance-mode", "deactivate"],
    params: [],
    json: false,
    requiresConfirmation: false,
  },
  {
    id: "option.update",
    purpose: "Update a specific WordPress option value.",
    argv: ["option", "update", ":option", ":value"],
    params: [
      { name: "option", kind: "option_key" },
      { name: "value", kind: "option_value" },
    ],
    json: false,
    requiresConfirmation: true, // direct DB write
  },
];

export const WP_CLI_WRITE_COMMAND_IDS: readonly string[] = WP_CLI_WRITE_CATALOG.map((e) => e.id);

// ---------------------------------------------------------------------------
// Param patterns (extends the read catalog's patterns)
// ---------------------------------------------------------------------------

const WRITE_PARAM_PATTERNS: Record<WpCliWriteParamKind, RegExp> = {
  plugin_slug: /^[a-z0-9][a-z0-9._-]{0,62}$/,
  theme_slug:  /^[a-z0-9][a-z0-9._-]{0,62}$/,
  option_key:  /^[a-z0-9_][a-z0-9_-]{0,62}$/,
  hook_name:   /^[a-zA-Z0-9_]{1,80}$/,
  option_value: /^[A-Za-z0-9._:/=@,+\- ]{1,200}$/,
};

// ---------------------------------------------------------------------------
// Build input / result (mirrors read catalog shape)
// ---------------------------------------------------------------------------

export type BuildWriteInput = {
  commandId: string;
  params?: Record<string, string | undefined>;
  wpRoot?: string | null;
  wpBinary?: string | null;
};

export type BuildWriteResult =
  | { ok: true; command: string; entry: WpCliWriteCommand; argv: string[] }
  | { ok: false; code: string; reason: string };

const quote = (token: string): string => `'${token}'`;

export const findWriteCommand = (commandId: string): WpCliWriteCommand | null =>
  WP_CLI_WRITE_CATALOG.find((e) => e.id === commandId) ?? null;

export const buildWpCliWriteCommand = (input: BuildWriteInput): BuildWriteResult => {
  const entry = findWriteCommand(input.commandId);
  if (!entry) {
    return { ok: false, code: "command_not_allowed", reason: "That isn't one of the write operations I can run." };
  }

  const root = validateWpRoot(input.wpRoot);
  if (!root.ok) return { ok: false, code: "invalid_input", reason: root.reason };

  const binary = validateWpBinary(input.wpBinary);
  if (!binary.ok) return { ok: false, code: "invalid_input", reason: binary.reason };

  const supplied = input.params ?? {};
  const provided = Object.keys(supplied).filter((k) => supplied[k] !== undefined);
  const expected = entry.params.map((p) => p.name);
  const unexpected = provided.filter((k) => !expected.includes(k));
  if (unexpected.length > 0) {
    return { ok: false, code: "invalid_input", reason: "That operation doesn't take those details." };
  }

  const resolved: string[] = [];
  for (const token of entry.argv) {
    if (!token.startsWith(":")) {
      resolved.push(token);
      continue;
    }
    const param = entry.params.find((p) => `:${p.name}` === token);
    if (!param) {
      return { ok: false, code: "command_not_allowed", reason: "That operation is not configured correctly." };
    }
    const raw = supplied[param.name];
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, code: "invalid_input", reason: "That operation needs one more detail before I can run it." };
    }
    const value = raw.trim();
    const pattern = WRITE_PARAM_PATTERNS[param.kind];
    if (!pattern.test(value)) {
      return { ok: false, code: "invalid_input", reason: "That value contains characters I won't send to a server." };
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
  if (!SAFE_COMMAND_LINE.test(command)) {
    return { ok: false, code: "command_not_allowed", reason: "I refused to build that command because part of it was unsafe." };
  }

  return { ok: true, command, entry, argv };
};
