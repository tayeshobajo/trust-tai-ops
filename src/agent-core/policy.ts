/**
 * Centralized risk and approval policy.
 *
 * Tools never decide whether they are allowed to run. The orchestrator asks
 * this module, once, for every action.
 */

import type { AgentAction, AgentContext, Capability, RiskClass, ToolId } from "./types";

const RISK_BY_TOOL: Record<ToolId, RiskClass> = {
  "public_http.inspect_site": "read_only",
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
  | { executable: false; requires: "access" | "backup" | "approval" | "backend"; reason: string };

const hasBackup = (context: AgentContext) => context.run.backupStatus !== "unconfirmed";

const hasApproval = (context: AgentContext) =>
  context.run.approvals.some(
    (approval) => approval.type === "high_risk_execution" && approval.status === "approved",
  );

const hasCapability = (context: AgentContext, capability: Capability) =>
  context.capabilities.includes(capability);

/** The single place that answers "may this action run right now?". */
export const evaluateAction = (action: AgentAction, context: AgentContext): PolicyVerdict => {
  if (!hasCapability(context, action.capability)) {
    return { executable: false, requires: "access", reason: "The access this step needs is not available yet." };
  }

  switch (action.risk) {
    case "read_only":
      return { executable: true };
    case "low_risk_change":
      // Small changes still require the run to be past the safety gate.
      return hasBackup(context)
        ? { executable: true }
        : { executable: false, requires: "backup", reason: "A safe restore point is needed first." };
    case "medium_risk_change":
      if (!hasBackup(context)) {
        return { executable: false, requires: "backup", reason: "A safe restore point is needed first." };
      }
      return { executable: true };
    case "high_risk_change":
      if (!hasBackup(context)) {
        return { executable: false, requires: "backup", reason: "A safe restore point is needed first." };
      }
      if (!hasApproval(context)) {
        return { executable: false, requires: "approval", reason: "This needs the owner's go-ahead first." };
      }
      return { executable: true };
    default:
      return { executable: false, requires: "approval", reason: "Unclassified action." };
  }
};
