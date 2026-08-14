/**
 * Centralized risk and approval policy.
 *
 * Tools never decide whether they are allowed to run. The orchestrator asks
 * this module, once, for every action.
 */

import type { AgentAction, AgentContext, Capability, RiskClass, ToolId } from "./types";
import { getProjectStack, stackCopy } from "../stacks";
import { checkReadBeforeWrite } from "./precondition";
import { writeTargetFor } from "./precondition";
import { constraintsTouching } from "./constraints";

const RISK_BY_TOOL: Record<ToolId, RiskClass> = {
  "public_http.inspect_site": "read_only",
  "browser.inspect_page_readonly": "read_only",
  "wordpress.inspect_public_surface": "read_only",
  "wordpress.list_plugins": "read_only",
  "wordpress.read_health": "read_only",
  "wordpress.read_error_log": "read_only",
  "wordpress.run_wp_cli_readonly": "read_only",
  "wordpress.execute_wp_cli": "high_risk_change",
  "filesystem.read": "read_only",
  "filesystem.write": "medium_risk_change",
  "database.query_readonly": "read_only",
  "database.execute": "high_risk_change",
};

export const classifyRisk = (toolId: ToolId): RiskClass => RISK_BY_TOOL[toolId];

export type PolicyVerdict =
  | { executable: true }
  | { executable: false; requires: "access" | "backup" | "approval" | "backend" | "read_first"; reason: string };

const hasBackup = (context: AgentContext) => context.run.backupStatus !== "unconfirmed";

const hasApproval = (context: AgentContext) =>
  context.run.approvals.some(
    (approval) => approval.type === "high_risk_execution" && approval.status === "approved",
  );

const hasCapability = (context: AgentContext, capability: Capability) =>
  context.capabilities.includes(capability);

/**
 * No change runs against something the agent has not read in this run. This
 * is what makes a rollback a fact rather than a hope.
 */
const requireReadFirst = (action: AgentAction, context: AgentContext): PolicyVerdict => {
  const check = checkReadBeforeWrite(action, context.evidence);
  return check.ok ? { executable: true } : { executable: false, requires: "read_first", reason: check.reason };
};

/**
 * A rule the person has stated outranks anything the reasoner proposes. If a
 * change touches something they told the agent to leave alone, it stops and
 * asks — even when every other gate is satisfied.
 */
const respectConstraints = (action: AgentAction, context: AgentContext): PolicyVerdict => {
  const target = writeTargetFor(action.toolId, action.args);
  if (!target) return { executable: true };

  const rules = constraintsTouching(context.project.memoryEntries, target);
  if (rules.length === 0) return { executable: true };

  return {
    executable: false,
    requires: "approval",
    reason: `You've told me: "${rules[0].content}" This step touches that, so I won't do it without you saying otherwise.`,
  };
};

/**
 * Tools that only make sense on WordPress. A Meteor project must never be
 * routed into them, no matter what a reasoner proposes.
 */
const WORDPRESS_ONLY_TOOLS = new Set<ToolId>([
  "wordpress.inspect_public_surface",
  "wordpress.list_plugins",
  "wordpress.read_health",
  "wordpress.read_error_log",
  "wordpress.run_wp_cli_readonly",
  "wordpress.execute_wp_cli",
]);

export const isToolEligibleForStack = (toolId: ToolId, stack: string): boolean =>
  !WORDPRESS_ONLY_TOOLS.has(toolId) || stack === "wordpress";

/** The single place that answers "may this action run right now?". */
const firstBlocker = (...verdicts: PolicyVerdict[]): PolicyVerdict =>
  verdicts.find((verdict) => !verdict.executable) ?? { executable: true };

export const evaluateAction = (action: AgentAction, context: AgentContext): PolicyVerdict => {
  const stack = getProjectStack(context.project);

  if (!isToolEligibleForStack(action.toolId, stack)) {
    return {
      executable: false,
      requires: "backend",
      reason: `This project runs on ${stackCopy[stack].label}. A ${stackCopy[stack].label} executor for this step does not exist yet, so the agent will not pretend to inspect it.`,
    };
  }

  if (!hasCapability(context, action.capability)) {
    return { executable: false, requires: "access", reason: "The access this step needs is not available yet." };
  }

  switch (action.risk) {
    case "read_only":
      return { executable: true };
    case "low_risk_change":
      // Small changes still require the run to be past the safety gate.
      if (!hasBackup(context)) {
        return { executable: false, requires: "backup", reason: "A safe restore point is needed first." };
      }
      return firstBlocker(respectConstraints(action, context), requireReadFirst(action, context));
    case "medium_risk_change":
      if (!hasBackup(context)) {
        return { executable: false, requires: "backup", reason: "A safe restore point is needed first." };
      }
      return firstBlocker(respectConstraints(action, context), requireReadFirst(action, context));
    case "high_risk_change":
      if (!hasBackup(context)) {
        return { executable: false, requires: "backup", reason: "A safe restore point is needed first." };
      }
      if (!hasApproval(context)) {
        return { executable: false, requires: "approval", reason: "This needs the owner's go-ahead first." };
      }
      return firstBlocker(respectConstraints(action, context), requireReadFirst(action, context));
    default:
      return { executable: false, requires: "approval", reason: "Unclassified action." };
  }
};
