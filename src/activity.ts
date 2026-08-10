import type { Project, Run } from "./types";
import { signalForRun } from "./home";

/**
 * Task history reconstruction.
 *
 * Everything shown here is rebuilt from existing run data. No audit records are
 * invented, and no state-machine vocabulary reaches the interface.
 */

export type TaskSummary = {
  run: Run;
  title: string;
  outcome: string;
  qaLabel: string | null;
  needsYou: string | null;
  stamp: string;
  isActive: boolean;
};

export const qaOutcomeLabel = (run: Run): string | null => {
  if (run.qaReport.results.every((result) => result.result === "skipped")) return null;
  switch (run.qaReport.verdict) {
    case "passed":
      return "Checks passed";
    case "partial":
      return "Completed with a warning";
    case "failed":
      return "Checks did not pass";
    case "waived":
      return "Checks waived by you";
    default:
      return null;
  }
};

const outcomeLabel = (run: Run): string => {
  switch (run.state) {
    case "complete":
      return run.qaReport.verdict === "partial" ? "Completed with a warning" : "Fix completed and checked";
    case "rolled_back":
      return "Changes rolled back";
    case "failed":
      return "Stopped before finishing";
    case "escalated":
      return "Escalated for a decision";
    case "paused":
      return "Paused until you reply";
    default:
      return signalForRun(run).status;
  }
};

export const buildTaskHistory = (project: Project): TaskSummary[] =>
  [...project.runs]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .map((run) => {
      const signal = signalForRun(run);
      return {
        run,
        title: run.title,
        outcome: outcomeLabel(run),
        qaLabel: qaOutcomeLabel(run),
        needsYou: signal.agentState === "needs_you" ? signal.needsYou ?? "Waiting on you" : null,
        stamp: run.updatedAt,
        isActive: run.state !== "complete" && run.state !== "rolled_back",
      };
    });

export type TaskSection = { id: string; title: string; lines: string[] };

export const buildTaskDetail = (run: Run): TaskSection[] => {
  const sections: TaskSection[] = [];

  if (run.taskSummary.trim()) {
    sections.push({ id: "request", title: "What you asked for", lines: [run.taskSummary.trim()] });
  }

  if (run.diagnosisSummary.trim() || run.findings.length > 0) {
    sections.push({
      id: "findings",
      title: "What the agent found",
      lines: [run.diagnosisSummary.trim(), ...run.findings.map((finding) => `${finding.title} — ${finding.summary}`)].filter(Boolean),
    });
  }

  if (run.planSummary.trim()) {
    sections.push({ id: "plan", title: "The plan", lines: [run.planSummary.trim()] });
  }

  const decisions = run.approvals.filter((approval) => approval.status !== "pending");
  if (decisions.length > 0) {
    sections.push({
      id: "decisions",
      title: "Your decisions",
      lines: decisions.map((approval) =>
        `${approval.status === "approved" ? "You approved" : "You asked for another approach"} — ${approval.reason}`,
      ),
    });
  }

  const work = run.actions.filter((action) => action.summary.trim());
  if (work.length > 0) {
    sections.push({
      id: "work",
      title: "What the agent did",
      lines: work.map((action) => action.summary),
    });
  }

  if (run.artifacts.length > 0) {
    sections.push({
      id: "evidence",
      title: "Evidence kept",
      lines: run.artifacts.map((artifact) => `${artifact.title} — ${artifact.summary}`),
    });
  }

  const qaLines = run.qaReport.results
    .filter((result) => result.result !== "skipped")
    .map((result) => {
      const verdict = result.result === "passed" ? "OK" : result.result === "warning" ? "Warning" : "Problem";
      return `${result.name} — ${verdict}${result.notes ? `: ${result.notes}` : ""}`;
    });
  if (run.qaReport.summary.trim() || qaLines.length > 0) {
    sections.push({
      id: "qa",
      title: "Final checks",
      lines: [run.qaReport.summary.trim(), ...qaLines].filter(Boolean),
    });
  }

  if (run.recommendations.length > 0) {
    sections.push({
      id: "recommendations",
      title: "Still recommended",
      lines: run.recommendations.map((item) => `${item.title} — ${item.summary}`),
    });
  }

  return sections;
};

/** Raw-ish detail kept behind a disclosure. Only real recorded data. */
export const buildTechnicalDetail = (run: Run): string[] => {
  const lines: string[] = [];
  for (const phase of run.phases) {
    if (phase.status === "pending") continue;
    lines.push(`${phase.label} — ${phase.summary || phase.status}`);
  }
  for (const action of run.actions) {
    lines.push(`${action.actor === "agent" ? "Agent" : action.actor === "operator" ? "You" : "System"}: ${action.summary} (${action.outcome})`);
  }
  return lines;
};
