/**
 * Reasoning boundary.
 *
 * The orchestrator asks an `AgentReasoner` what should happen next. The
 * deterministic reasoner is a real, rule-based operator fallback: it only picks
 * public read-only inspections, and only from evidence it actually has. The
 * server reasoner is the seat for a real model; it is inert until a server-side
 * provider is configured, and it never runs in the browser.
 */

import type { AccessType } from "../types";
import { getProjectStack, stackCopy } from "../stacks";
import { planAction } from "./registry";
import { executionGateway } from "./gateway";
import { materializeServerPlan } from "./reasonPlan";
import type {
  AgentAction,
  AgentActionArguments,
  AgentContext,
  AgentDecision,
  AgentPlan,
  ToolId,
} from "./types";

export interface AgentReasoner {
  readonly id: string;
  available(): boolean;
  plan(context: AgentContext): Promise<AgentPlan | null>;
}

const hasEvidenceFrom = (context: AgentContext, toolId: ToolId) =>
  context.evidence.some((item) => item.toolId === toolId);

/**
 * The catalog inspection each planned WP-CLI action stands for. Named here so
 * the planner can never assemble a command; it only chooses a catalog id.
 */
const WP_CLI_ACTION_COMMANDS: Record<string, string> = {
  "wp-cli-core-version": "core.version",
  "wp-cli-core-checksums": "core.verify_checksums",
};

const wpCliArgsFor = (actionId: string): AgentActionArguments | null => {
  const commandId = WP_CLI_ACTION_COMMANDS[actionId];
  return commandId ? { commandId } : null;
};

/** True only when something actually observed says this is WordPress. */
const wordpressMarkersPresent = (context: AgentContext): boolean =>
  context.evidence.some((item) => {
    if (item.toolId === "public_http.inspect_site") {
      const generator = typeof item.data.generator === "string" ? item.data.generator : "";
      return item.data.wordpressSignals === true || /wordpress/i.test(generator);
    }
    if (item.toolId === "wordpress.inspect_public_surface") {
      const namespaces = Array.isArray(item.data.namespaces) ? (item.data.namespaces as string[]) : [];
      return item.data.restApiAvailable === true || namespaces.some((ns) => ns.startsWith("wp/"));
    }
    return false;
  });

/**
 * The next access to ask for — never a wish list. WordPress Admin answers the
 * next question for almost every investigation, so server or file access is
 * only requested when the task genuinely cannot start without it.
 */
const minimumAccessFor = (context: AgentContext): AccessType[] => {
  const stack = getProjectStack(context.project);
  if (stack !== "wordpress") {
    // No WordPress admin exists to ask for. Ask for the access this stack
    // actually uses instead.
    return stackCopy[stack].accessTypes.filter((type) => !context.capabilities.includes(type)).slice(0, 1);
  }

  if (context.capabilities.includes("wordpress_admin")) {
    // Admin is already in place: only now can a deeper level be justified.
    // Malware work genuinely needs the filesystem; a core integrity question
    // genuinely needs the server itself. Nothing else is asked for.
    if (context.run.taskType === "malware") return ["sftp"];
    if (!context.capabilities.includes("ssh") && needsServerInspection(context)) return ["ssh"];
    return [];
  }
  return ["wordpress_admin"];
};

/**
 * True only when the public and admin reads have already been done and a
 * server-side question is genuinely still open.
 */
const needsServerInspection = (context: AgentContext): boolean =>
  hasEvidenceFrom(context, "wordpress.list_plugins") &&
  ["malware", "performance", "update", "recovery"].includes(context.run.taskType);

/** Task types where runtime PHP errors are genuinely useful evidence. */
const ERROR_LOG_TASK_TYPES: readonly string[] = [
  "broken_site",
  "plugin_theme_conflict",
  "performance",
  "malware",
];

const emptyPlan = (decision: AgentDecision): AgentPlan => ({
  decision,
  actions: [],
  riskSummary: "read_only",
  expectedOutcome: decision.rationale,
  qaPlan: [],
});

class DeterministicReasoner implements AgentReasoner {
  readonly id = "deterministic";

  available(): boolean {
    return true;
  }

  async plan(context: AgentContext): Promise<AgentPlan> {
    const url = context.environment.primaryUrl;
    const stack = getProjectStack(context.project);
    const wordPressStack = stack === "wordpress";

    if (!url) {
      return emptyPlan({
        intent: "request_access",
        rationale: "No site address is recorded for this project.",
        message: ["I don't have the site address for this project yet. What is the URL I should be looking at?"],
      });
    }

    const actions: AgentAction[] = [];
    const want: Array<{ id: string; toolId: ToolId; purpose: string }> = [];

    if (!hasEvidenceFrom(context, "public_http.inspect_site")) {
      want.push({
        id: "inspect-site",
        toolId: "public_http.inspect_site",
        purpose: "See how the public site responds from outside.",
      });
    } else if (!wordPressStack) {
      // Stack-neutral public checks are legitimate anywhere. WordPress-only
      // tools are not, so a non-WordPress project stops here rather than
      // pretending to inspect something it does not run.
    } else if (!hasEvidenceFrom(context, "wordpress.inspect_public_surface")) {
      want.push({
        id: "inspect-wp-public",
        toolId: "wordpress.inspect_public_surface",
        purpose: "Read the publicly visible WordPress signals.",
      });
    } else if (wordpressMarkersPresent(context) && !hasEvidenceFrom(context, "wordpress.read_health")) {
      want.push({
        id: "read-health",
        toolId: "wordpress.read_health",
        purpose: "Read the site's health signals now that WordPress is confirmed.",
      });
    } else if (
      wordpressMarkersPresent(context) &&
      context.capabilities.includes("wordpress_admin") &&
      !hasEvidenceFrom(context, "wordpress.list_plugins")
    ) {
      // Admin access is now confirmed by the server, so the private reads that
      // the public surface could not answer become possible.
      want.push({
        id: "read-health-authenticated",
        toolId: "wordpress.read_health",
        purpose: "Read the private health checks now that admin access is available.",
      });
      want.push({
        id: "list-plugins",
        toolId: "wordpress.list_plugins",
        purpose: "Read the installed plugins without changing anything.",
      });
    } else if (
      context.capabilities.includes("ssh") &&
      !hasEvidenceFrom(context, "wordpress.run_wp_cli_readonly")
    ) {
      // SSH is available, so the questions the HTTP surface cannot answer —
      // the real installed version, and whether core files were altered —
      // become answerable. Both are strictly reads.
      want.push({
        id: "wp-cli-core-version",
        toolId: "wordpress.run_wp_cli_readonly",
        purpose: "Read the WordPress version directly on the server.",
      });
      want.push({
        id: "wp-cli-core-checksums",
        toolId: "wordpress.run_wp_cli_readonly",
        purpose: "Compare the core files against the official checksums.",
      });
    }

    // Runtime errors are worth reading only when the task is the kind that
    // they explain, WordPress is established, SSH is available, and the log
    // has not already been read for this run. If it turns out to be
    // unavailable, the run continues on other evidence rather than retrying.
    if (
      wordPressStack &&
      wordpressMarkersPresent(context) &&
      context.capabilities.includes("ssh") &&
      ERROR_LOG_TASK_TYPES.includes(context.run.taskType) &&
      !hasEvidenceFrom(context, "wordpress.read_error_log")
    ) {
      want.push({
        id: "read-error-log",
        toolId: "wordpress.read_error_log",
        purpose: "Read the recent WordPress error log entries, without changing anything.",
      });
    }

    for (const item of want) {
      // Private tools resolve their own target server-side from the project.
      const args: AgentActionArguments = wpCliArgsFor(item.id) ??
        (item.toolId === "wordpress.list_plugins" || item.toolId === "wordpress.read_error_log" ? {} : { url });
      const built = planAction(item.id, item.toolId, context.run.id, args, item.purpose);
      if ("error" in built) {
        return emptyPlan({
          intent: "report_findings",
          rationale: built.error,
          message: [built.error],
        });
      }
      actions.push(built);
    }

    if (actions.length === 0) {
      const privateAccess = minimumAccessFor(context).filter(
        (type) => !context.capabilities.includes(type),
      );
      if (privateAccess.length > 0) {
        return emptyPlan({
          intent: "request_access",
          rationale: "Public checks are done; anything deeper needs private access.",
          requestedAccess: privateAccess,
        });
      }
      return emptyPlan({
        intent: "report_findings",
        rationale: wordPressStack
          ? "Public checks are done and access is available."
          : `Public checks are done. A ${stackCopy[stack].label} executor for deeper inspection does not exist yet, so nothing further can be checked automatically.`,
      });
    }

    return {
      decision: {
        intent: "inspect_public_surface",
        rationale: "Start from what can be observed publicly, before asking for anything private.",
      },
      actions,
      riskSummary: "read_only",
      expectedOutcome: "A real, observed picture of how the site behaves from outside.",
      qaPlan: ["Re-check the public response after any change.", "Confirm the reported symptom is gone."],
    };
  }
}

/** Schema validation for anything a model returns. Invalid plans are rejected. */
export const isValidPlan = (value: unknown): value is AgentPlan => {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<AgentPlan>;
  const decision = plan.decision;
  if (!decision || typeof decision !== "object") return false;
  const intents = [
    "inspect_public_surface",
    "request_access",
    "report_findings",
    "await_human_decision",
    "no_action",
  ];
  if (!intents.includes(decision.intent as string)) return false;
  if (typeof decision.rationale !== "string") return false;
  if (!Array.isArray(plan.actions)) return false;
  return plan.actions.every(
    (action) =>
      Boolean(action) &&
      typeof action.id === "string" &&
      typeof action.toolId === "string" &&
      typeof action.invocationKey === "string" &&
      typeof action.readOnly === "boolean" &&
      typeof action.args === "object" &&
      action.args !== null,
  );
};

/**
 * The redacted picture the server-side reasoner is allowed to see. No
 * credential, no header, no raw provider error, no full URL — only what has
 * already been said in plain English and what has already been observed.
 */
export const reasoningDigest = (context: AgentContext): Record<string, unknown> => ({
  stack: getProjectStack(context.project),
  taskType: context.run.taskType,
  taskTitle: context.run.title ?? "",
  siteKnown: Boolean(context.environment.primaryUrl),
  capabilities: context.capabilities,
  verifiedCapabilities: context.verifiedCapabilities ?? [],
  evidence: context.evidence.slice(-12).map((item) => ({ toolId: item.toolId, summary: item.summary })),
  messages: context.recentMessages
    .slice(-12)
    // Persisted messages are already sanitized; redacting again means no
    // credential-shaped text can reach a model even if one ever slipped in.
    .map((message) => ({ role: message.role, text: redactSecrets(message.body.join(" ")) })),
  memory: context.memory.slice(-8).map((entry) => redactSecrets(`${entry.title}: ${entry.content}`)),
});

/**
 * Server-side model reasoner. The model never runs in the browser and never
 * sees a credential: the browser asks the `agent-reason` function, and only a
 * plan drawn from the closed catalog comes back. Any doubt returns null so the
 * deterministic operator takes the turn instead.
 */
class ServerModelReasoner implements AgentReasoner {
  readonly id = "server-model";

  available(): boolean {
    // Reasoning lives behind the same server boundary as execution.
    return executionGateway().available();
  }

  async plan(context: AgentContext): Promise<AgentPlan | null> {
    if (!this.available()) return null;
    const payload = await executionGateway().reason(context.project.id, reasoningDigest(context));
    if (!payload) return null;
    const plan = materializeServerPlan(payload, {
      runId: context.run.id,
      url: context.environment.primaryUrl,
      capabilities: context.capabilities,
      stack: getProjectStack(context.project),
    });
    if (!plan || !isValidPlan(plan)) return null;
    // A reasoning layer may never plan a change: this pass is read-only.
    if (plan.actions.some((action) => !action.readOnly)) return null;
    return plan;
  }
}

export const deterministicReasoner: AgentReasoner = new DeterministicReasoner();
export const serverModelReasoner: AgentReasoner = new ServerModelReasoner();

/**
 * Real reasoning first, deterministic operator as the floor. The fallback is
 * not an error path: it is how the agent stays useful when the model is
 * unavailable, rate limited, or returns something outside the catalog.
 */
class FallbackReasoner implements AgentReasoner {
  readonly id = "server-model+deterministic";

  private readonly preferred: AgentReasoner;
  private readonly floor: AgentReasoner;

  constructor(preferred: AgentReasoner, floor: AgentReasoner) {
    this.preferred = preferred;
    this.floor = floor;
  }

  available(): boolean {
    return true;
  }

  async plan(context: AgentContext): Promise<AgentPlan | null> {
    if (this.preferred.available()) {
      try {
        const plan = await this.preferred.plan(context);
        if (plan) return plan;
      } catch {
        // Fall through: an unreachable model must never stall a run.
      }
    }
    return this.floor.plan(context);
  }
}

export const selectReasoner = (): AgentReasoner =>
  new FallbackReasoner(serverModelReasoner, deterministicReasoner);
