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
  sensitivity: "public",
  redacted: true,
  observedAt: new Date().toISOString(),
});

/** Both implemented tools run entirely server-side, through the gateway. */
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
  "wordpress.list_plugins": declared(
    "wordpress.list_plugins",
    "List installed plugins and their versions.",
    "wordpress_admin",
    true,
    "I can't list the plugins yet — that needs WordPress admin access.",
  ),
  "wordpress.read_health": declared(
    "wordpress.read_health",
    "Read the WordPress site health report.",
    "wordpress_admin",
    true,
    "I can't read site health yet — that needs WordPress admin access.",
  ),
  "wordpress.read_error_log": declared(
    "wordpress.read_error_log",
    "Read the PHP/WordPress error log.",
    "sftp",
    true,
    "I can't read the error log yet — that needs file access to the server.",
  ),
  "wordpress.run_wp_cli_readonly": declared(
    "wordpress.run_wp_cli_readonly",
    "Run a read-only WP-CLI inspection command.",
    "ssh",
    true,
    "I can't run server-side inspections yet — that needs SSH access.",
  ),
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
