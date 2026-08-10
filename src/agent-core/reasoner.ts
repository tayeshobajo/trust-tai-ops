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
import { planAction } from "./registry";
import type { AgentAction, AgentContext, AgentDecision, AgentPlan, ToolId } from "./types";

export interface AgentReasoner {
  readonly id: string;
  available(): boolean;
  plan(context: AgentContext): Promise<AgentPlan | null>;
}

const hasEvidenceFrom = (context: AgentContext, toolId: ToolId) =>
  context.evidence.some((item) => item.toolId === toolId);

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

const minimumAccessFor = (context: AgentContext): AccessType[] => {
  switch (context.run.taskType) {
    case "malware":
      return ["wordpress_admin", "sftp"];
    case "performance":
      return ["wordpress_admin"];
    case "broken_site":
      return ["wordpress_admin", "sftp"];
    case "plugin_theme_conflict":
      return ["wordpress_admin"];
    default:
      return ["wordpress_admin"];
  }
};

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
    }

    for (const item of want) {
      const built = planAction(item.id, item.toolId, context.run.id, { url }, item.purpose);
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
        rationale: "Public checks are done and access is available.",
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
 * Server-side model reasoner. Scaffold only: it reports itself unavailable
 * unless a server-side provider is configured, and the orchestrator then uses
 * the deterministic reasoner. No provider key is ever read in the browser.
 */
class ServerModelReasoner implements AgentReasoner {
  readonly id = "server-model";

  available(): boolean {
    // Flipped on only when the reasoning function is deployed and configured
    // server-side. There is deliberately no client-side provider credential.
    return false;
  }

  async plan(): Promise<AgentPlan | null> {
    return null;
  }
}

export const deterministicReasoner: AgentReasoner = new DeterministicReasoner();
export const serverModelReasoner: AgentReasoner = new ServerModelReasoner();

/** Prefers real reasoning when it is genuinely configured; falls back safely. */
export const selectReasoner = (): AgentReasoner =>
  serverModelReasoner.available() ? serverModelReasoner : deterministicReasoner;
