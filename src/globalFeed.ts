import type { Organization, Project, Run } from "./types";
import { signalForRun } from "./home";
import { buildTaskHistory } from "./activity";

/**
 * Cross-project derivations for the global Activity and Approvals surfaces.
 *
 * Presentation only: every item is read from existing project/run data. No new
 * domain state, no invented records, no writes.
 */

export type GlobalActivityItem = {
  id: string;
  projectId: string;
  projectName: string;
  domain: string;
  headline: string;
  detail: string;
  stamp: string;
  tone: "working" | "attention" | "done" | "neutral";
  technical: string[];
};

export const buildGlobalActivity = (workspace: Organization, limit = 40): GlobalActivityItem[] => {
  const items: GlobalActivityItem[] = [];

  for (const project of workspace.projects) {
    for (const risk of project.riskFlags) {
      if (risk.status !== "open" && risk.status !== "monitoring") continue;
      items.push({
        id: `${project.id}:risk:${risk.id}`,
        projectId: project.id,
        projectName: project.name,
        domain: project.primaryDomain,
        headline: risk.title,
        detail: risk.summary,
        stamp: risk.createdAt ?? "",
        tone: "attention",
        technical: [`Severity: ${risk.severity}`, `Status: ${risk.status}`],
      });
    }

    for (const task of buildTaskHistory(project)) {
      const signal = signalForRun(task.run);
      const tone: GlobalActivityItem["tone"] = task.needsYou
        ? "attention"
        : task.isActive
          ? "working"
          : "done";

      items.push({
        id: `${project.id}:${task.run.id}`,
        projectId: project.id,
        projectName: project.name,
        domain: project.primaryDomain,
        headline: task.title,
        detail: task.needsYou ?? task.outcome,
        stamp: task.stamp,
        tone,
        technical: [
          signal.detail,
          ...task.run.actions.slice(-3).map((action) => action.summary),
          task.qaLabel ?? "",
        ].filter((line): line is string => Boolean(line && line.trim())),
      });
    }
  }

  return items.sort((a, b) => (b.stamp || "").localeCompare(a.stamp || "")).slice(0, limit);
};

export type PendingDecision = {
  id: string;
  projectId: string;
  projectName: string;
  domain: string;
  kind: "approval" | "backup" | "access" | "decision";
  label: string;
  decision: string;
  why: string;
  stamp: string;
};

const kindLabel: Record<PendingDecision["kind"], string> = {
  approval: "Approval",
  backup: "Backup",
  access: "Access",
  decision: "Decision",
};

const decisionForRun = (project: Project, run: Run): PendingDecision | null => {
  const signal = signalForRun(run);

  if (signal.agentState !== "needs_you") {
    return null;
  }

  const pendingApproval = run.approvals.find((approval) => approval.status === "pending");

  const kind: PendingDecision["kind"] = run.state === "access_check"
    ? "access"
    : run.state === "backup_gate"
      ? "backup"
      : pendingApproval
        ? "approval"
        : "decision";

  return {
    id: `${project.id}:${run.id}`,
    projectId: project.id,
    projectName: project.name,
    domain: project.primaryDomain,
    kind,
    label: kindLabel[kind],
    decision: signal.needsYou ?? signal.status,
    why: pendingApproval?.reason || signal.detail || run.operatorPrompt,
    stamp: run.updatedAt,
  };
};

export const buildPendingDecisions = (workspace: Organization): PendingDecision[] => {
  const decisions: PendingDecision[] = [];

  for (const project of workspace.projects) {
    for (const run of project.runs) {
      const decision = decisionForRun(project, run);
      if (decision) {
        decisions.push(decision);
      }
    }
  }

  return decisions.sort((a, b) => (b.stamp || "").localeCompare(a.stamp || ""));
};

export const countPendingDecisions = (workspace: Organization) => buildPendingDecisions(workspace).length;
