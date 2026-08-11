/**
 * Tool registry.
 *
 * One declaration per WordPress operations capability. Tools that are not
 * implemented yet are declared so the planner can reason about what it would
 * need — they return an honest "not available" result and never a fake one.
 */

import { classifyRisk } from "./policy";
import { executionGateway } from "./gateway";
import { validatePublicUrl, safeSummary } from "./safety";
import { isWpCliCommandId, WP_CLI_COMMAND_PARAMS, type WpCliCommandId } from "./wpCliCommands";
import type {
  AgentAction,
  AgentActionArguments,
  AgentEvidence,
  AgentToolResult,
  Capability,
  RiskClass,
  ToolId,
} from "./types";

export type ToolValidation = { ok: true; args: AgentActionArguments } | { ok: false; reason: string };

export type ToolDefinition = {
  id: ToolId;
  /** Plain-English purpose. Safe to paraphrase to a human. */
  purpose: string;
  capability: Capability;
  readOnly: boolean;
  risk: RiskClass;
  implemented: boolean;
  validate: (args: AgentActionArguments) => ToolValidation;
  execute: (action: AgentAction, projectId: string, runId: string | null) => Promise<AgentToolResult>;
};

// --- deterministic invocation keys -----------------------------------------

const stableStringify = (args: AgentActionArguments): string =>
  JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => [key, args[key]]),
  );

const fingerprint = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * Identity of a planned invocation: run + tool + arguments. Never time-based,
 * so replaying the same turn reuses the same record instead of acting twice.
 */
export const invocationKeyFor = (runId: string | null, toolId: ToolId, args: AgentActionArguments): string =>
  `${runId ?? "project"}:${toolId}:${fingerprint(stableStringify(args))}`;

// --- helpers ----------------------------------------------------------------

const requireUrl = (args: AgentActionArguments): ToolValidation => {
  const url = typeof args.url === "string" ? args.url : "";
  const check = validatePublicUrl(url);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, args: { url: check.url.toString() } };
};

const notAvailable = (summary: string): AgentToolResult => ({
  ok: false,
  code: "not_implemented",
  summary,
  retryable: false,
});

/**
 * Evidence read through private access is marked `restricted` so the rest of
 * the system can keep it separate from anything publicly observable.
 */
const sensitivityFor = (toolId: ToolId, data: Record<string, unknown>): AgentEvidence["sensitivity"] => {
  if (toolId === "wordpress.list_plugins") return "restricted";
  if (toolId === "wordpress.run_wp_cli_readonly") return "restricted";
  if (toolId === "wordpress.read_health" && data.authenticatedHealthAvailable === true) return "restricted";
  return "public";
};

/**
 * A WP-CLI action names an inspection from the closed catalog and nothing
 * else. There is no free-text command field to validate, because none exists.
 * The server re-checks all of this; this is the first gate, not the only one.
 */
const requireWpCliCommand = (args: AgentActionArguments): ToolValidation => {
  const commandId = args.commandId;
  if (!isWpCliCommandId(commandId)) {
    return { ok: false, reason: "That isn't one of the read-only server inspections I can run." };
  }

  const paramName = WP_CLI_COMMAND_PARAMS[commandId as WpCliCommandId];
  const next: AgentActionArguments = { commandId };

  if (paramName) {
    const value = args[paramName];
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.trim().toLowerCase())) {
      return { ok: false, reason: "That inspection needs a valid name before I can run it." };
    }
    next[paramName] = value.trim().toLowerCase();
  }

  // Any other argument is dropped rather than forwarded.
  return { ok: true, args: next };
};

const evidenceFrom = (
  toolId: ToolId,
  invocationKey: string,
  summary: string,
  data: Record<string, unknown>,
): AgentEvidence => ({
  id: `${invocationKey}:evidence`,
  toolId,
  summary: safeSummary(summary),
  data,
  sensitivity: sensitivityFor(toolId, data),
  redacted: true,
  observedAt: new Date().toISOString(),
});

/** Every implemented tool runs entirely server-side, through the gateway. */
const runThroughGateway = async (
  action: AgentAction,
  projectId: string,
  runId: string | null,
): Promise<AgentToolResult> => {
  const response = await executionGateway().invoke({
    projectId,
    runId,
    actionId: action.id,
    toolId: action.toolId,
    invocationKey: action.invocationKey,
    args: action.args,
  });

  if (!response.ok) {
    return { ok: false, code: response.code, summary: safeSummary(response.summary), retryable: response.retryable };
  }

  return {
    ok: true,
    summary: safeSummary(response.summary),
    evidence: [evidenceFrom(action.toolId, action.invocationKey, response.summary, response.data)],
  };
};

// --- registry ---------------------------------------------------------------

const declared = (
  id: ToolId,
  purpose: string,
  capability: Capability,
  readOnly: boolean,
  unavailableSummary: string,
): ToolDefinition => ({
  id,
  purpose,
  capability,
  readOnly,
  risk: classifyRisk(id),
  implemented: false,
  validate: (args) => ({ ok: true, args }),
  execute: async () => notAvailable(unavailableSummary),
});

export const TOOL_REGISTRY: Record<ToolId, ToolDefinition> = {
  "public_http.inspect_site": {
    id: "public_http.inspect_site",
    purpose: "Check how the public site responds from the outside.",
    capability: "public_internet",
    readOnly: true,
    risk: classifyRisk("public_http.inspect_site"),
    implemented: true,
    validate: requireUrl,
    execute: runThroughGateway,
  },
  "wordpress.inspect_public_surface": {
    id: "wordpress.inspect_public_surface",
    purpose: "Read the publicly exposed WordPress signals on the site.",
    capability: "public_internet",
    readOnly: true,
    risk: classifyRisk("wordpress.inspect_public_surface"),
    implemented: true,
    validate: requireUrl,
    execute: runThroughGateway,
  },
  "wordpress.list_plugins": {
    id: "wordpress.list_plugins",
    purpose: "Read the installed plugins and their versions, without changing anything.",
    capability: "wordpress_admin",
    readOnly: true,
    risk: classifyRisk("wordpress.list_plugins"),
    implemented: true,
    // The site address is resolved server-side from the authorized project, so
    // no client-supplied URL is accepted for a credentialed call.
    validate: () => ({ ok: true, args: {} }),
    execute: runThroughGateway,
  },
  "wordpress.read_health": {
    id: "wordpress.read_health",
    purpose: "Read the site's health signals, and check what needs admin access.",
    // The server decides what it can actually read; the public health signals
    // need nothing private, and it reports honestly what admin access unlocks.
    capability: "public_internet",
    readOnly: true,
    risk: classifyRisk("wordpress.read_health"),
    implemented: true,
    validate: requireUrl,
    execute: runThroughGateway,
  },
  "wordpress.read_error_log": {
    id: "wordpress.read_error_log",
    purpose: "Read a bounded tail of WordPress's own error log, without changing anything.",
    // The read runs over the SSH credential's file subsystem, so SSH is the
    // access this genuinely needs — not a separate SFTP login.
    capability: "ssh",
    readOnly: true,
    risk: classifyRisk("wordpress.read_error_log"),
    implemented: true,
    // The server derives every path it may open. A client cannot name one.
    validate: () => null,
    execute: runThroughGateway,
  },
  "wordpress.run_wp_cli_readonly": {
    id: "wordpress.run_wp_cli_readonly",
    purpose: "Run a read-only WP-CLI inspection on the server, without changing anything.",
    capability: "ssh",
    readOnly: true,
    risk: classifyRisk("wordpress.run_wp_cli_readonly"),
    implemented: true,
    validate: requireWpCliCommand,
    execute: runThroughGateway,
  },
  "wordpress.execute_wp_cli": declared(
    "wordpress.execute_wp_cli",
    "Apply a change through WP-CLI.",
    "ssh",
    false,
    "Applying changes on the server is not enabled yet.",
  ),
  "filesystem.read": declared(
    "filesystem.read",
    "Read a specific file from the server.",
    "sftp",
    true,
    "I can't read server files yet — that needs SFTP or SSH access.",
  ),
  "filesystem.write": declared(
    "filesystem.write",
    "Write or replace a file on the server.",
    "sftp",
    false,
    "Writing files on the server is not enabled yet.",
  ),
  "database.query_readonly": declared(
    "database.query_readonly",
    "Run a read-only database query.",
    "database",
    true,
    "I can't query the database yet — that needs database access.",
  ),
  "database.execute": declared(
    "database.execute",
    "Change data in the database.",
    "database",
    false,
    "Changing the database is not enabled yet.",
  ),
};

export const getTool = (id: ToolId): ToolDefinition => TOOL_REGISTRY[id];

/** Does the run currently hold what this tool needs? */
export const toolIsUsable = (id: ToolId, capabilities: Capability[]): boolean =>
  TOOL_REGISTRY[id].implemented && capabilities.includes(TOOL_REGISTRY[id].capability);

/** Builds a fully-formed action from a tool id, with a deterministic key. */
export const planAction = (
  actionId: string,
  toolId: ToolId,
  runId: string | null,
  args: AgentActionArguments,
  purpose?: string,
): AgentAction | { error: string } => {
  const tool = getTool(toolId);
  const validation = tool.validate(args);
  if (!validation.ok) return { error: validation.reason };

  return {
    id: actionId,
    toolId,
    purpose: purpose ?? tool.purpose,
    capability: tool.capability,
    readOnly: tool.readOnly,
    risk: tool.risk,
    args: validation.args,
    invocationKey: invocationKeyFor(runId, toolId, validation.args),
  };
};
