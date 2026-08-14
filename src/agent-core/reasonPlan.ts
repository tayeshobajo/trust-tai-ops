/**
 * Client mirror of the closed reasoning catalog.
 *
 * The server returns catalog ids and plain-English prose. The real action —
 * tool, arguments, capability, risk, invocation key — is rebuilt here from the
 * registry, so a model can never author an argument or a command.
 */

import { planAction } from "./registry";
import { isToolEligibleForStack } from "./policy";
import type { AgentAction, AgentActionArguments, AgentPlan, ToolId } from "./types";
import { accessTypesForStack } from "../stacks";
import type { AccessType, ProjectStack } from "../types";

export type ReasonStepSpec = {
  toolId: ToolId;
  capability: string;
  /** Fixed catalog command, WP-CLI steps only. */
  commandId?: string;
  /** Fixed viewport, browser steps only. */
  viewport?: "desktop" | "mobile";
  /** True when the tool resolves its own target server-side. */
  serverResolvedTarget: boolean;
  purpose: string;
};

export const REASON_STEPS: Record<string, ReasonStepSpec> = {
  "inspect-site": {
    toolId: "public_http.inspect_site",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "See how the public site responds from outside.",
  },
  "inspect-page-desktop": {
    toolId: "browser.inspect_page_readonly",
    capability: "public_internet",
    serverResolvedTarget: false,
    viewport: "desktop",
    purpose: "Load the page in a real browser on a desktop screen and watch how it performs.",
  },
  "inspect-page-mobile": {
    toolId: "browser.inspect_page_readonly",
    capability: "public_internet",
    serverResolvedTarget: false,
    viewport: "mobile",
    purpose: "Load the page in a real browser on a phone-sized screen and watch how it performs.",
  },
  "inspect-wp-public": {
    toolId: "wordpress.inspect_public_surface",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Read the publicly visible WordPress signals.",
  },
  "read-health": {
    toolId: "wordpress.read_health",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Read the site's health signals.",
  },
  "read-health-authenticated": {
    toolId: "wordpress.read_health",
    capability: "wordpress_admin",
    serverResolvedTarget: false,
    purpose: "Read the private health checks using the stored WordPress admin access.",
  },
  "list-plugins": {
    toolId: "wordpress.list_plugins",
    capability: "wordpress_admin",
    serverResolvedTarget: true,
    purpose: "Read the installed plugins without changing anything.",
  },
  "wp-cli-core-version": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "core.version",
    purpose: "Read the WordPress version directly on the server.",
  },
  "wp-cli-core-checksums": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "core.verify_checksums",
    purpose: "Compare the core files against the official checksums.",
  },
  "read-error-log": {
    toolId: "wordpress.read_error_log",
    capability: "ssh",
    serverResolvedTarget: true,
    purpose: "Read the recent WordPress error log entries, without changing anything.",
  },
  "wp-cli-core-updates": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "core.check_update",
    purpose: "Check whether WordPress itself is behind on updates.",
  },
  "wp-cli-plugin-list": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "plugin.list",
    purpose: "Read the installed plugins and their update status directly on the server.",
  },
  "wp-cli-theme-list": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "theme.list",
    purpose: "Read the installed themes and which one is active.",
  },
  "wp-cli-cron-events": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "cron.event_list",
    purpose: "Read the scheduled jobs, including anything unexpected that was added.",
  },
  "wp-cli-maintenance-mode": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "maintenance_mode.status",
    purpose: "Check whether the site is stuck in maintenance mode.",
  },
  "wp-cli-user-roles": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "user.list_roles",
    purpose: "Read the account roles defined on the site.",
  },
  "wp-cli-db-size": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "db.size",
    purpose: "Read how large the database has grown.",
  },
  "wp-cli-debug-log-setting": {
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "config.get_debug_log",
    purpose: "Check whether error logging is switched on before looking for a log.",
  },
};

export type ServerReasonPlan = {
  intent: string;
  rationale: string;
  message?: string[];
  requestedAccess?: string[];
  steps?: Array<{ id: string; purpose?: string }>;
  expectedOutcome?: string;
  qaPlan?: string[];
};

const INTENTS = [
  "inspect_public_surface",
  "request_access",
  "report_findings",
  "await_human_decision",
  "no_action",
] as const;

const ACCESS_TYPES: AccessType[] = [
  "wordpress_admin",
  "sftp",
  "ssh",
  "hosting_portal",
  "database",
  "cdn",
  "server_pm2",
  "ci_cd",
  "container",
];

/**
 * Rebuilds a real, executable plan from a server answer. Returns null whenever
 * anything is unknown, unsupported, or beyond the capabilities this run
 * actually holds — the caller then falls back to the deterministic operator.
 */
export const materializeServerPlan = (
  payload: unknown,
  options: { runId: string | null; url: string | null; capabilities: string[]; stack?: ProjectStack },
): AgentPlan | null => {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as ServerReasonPlan;
  if (!(INTENTS as readonly string[]).includes(raw.intent)) return null;
  if (typeof raw.rationale !== "string" || raw.rationale.trim().length === 0) return null;

  const stack: ProjectStack = options.stack ?? "wordpress";

  const actions: AgentAction[] = [];
  const seen = new Set<string>();
  for (const step of raw.steps ?? []) {
    const spec = REASON_STEPS[step?.id ?? ""];
    if (!spec) return null;
    // A WordPress-only step can never become an action on another stack, even
    // before the server's own execution guard sees it.
    if (!isToolEligibleForStack(spec.toolId, stack)) return null;
    if (!options.capabilities.includes(spec.capability)) return null;
    if (seen.has(step.id)) continue;
    seen.add(step.id);

    let args: AgentActionArguments;
    if (spec.commandId) args = { commandId: spec.commandId };
    else if (spec.serverResolvedTarget) args = {};
    else {
      if (!options.url) return null;
      args = spec.viewport ? { url: options.url, viewport: spec.viewport } : { url: options.url };
    }

    const built = planAction(step.id, spec.toolId, options.runId, args, step.purpose || spec.purpose);
    if ("error" in built) return null;
    if (!built.readOnly) return null; // this layer never plans a change
    actions.push(built);
  }

  if (raw.intent === "request_access" && actions.length > 0) return null;

  // Only access this stack actually uses may be asked for.
  const allowedAccess = new Set<string>(accessTypesForStack(stack));
  const requestedAccess = (raw.requestedAccess ?? []).filter(
    (item): item is AccessType => (ACCESS_TYPES as string[]).includes(item) && allowedAccess.has(item),
  );

  return {
    decision: {
      intent: raw.intent as AgentPlan["decision"]["intent"],
      rationale: raw.rationale,
      ...(requestedAccess.length > 0 ? { requestedAccess } : {}),
      ...(raw.message && raw.message.length > 0 ? { message: raw.message } : {}),
    },
    actions,
    riskSummary: "read_only",
    expectedOutcome: raw.expectedOutcome || raw.rationale,
    qaPlan: Array.isArray(raw.qaPlan) ? raw.qaPlan.filter((line) => typeof line === "string") : [],
  };
};