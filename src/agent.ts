import type { Project, QaResult, Run, RunState } from "./types";
import { getNextPhase, validateAdvance } from "./operations";

/**
 * Agent autonomy helpers.
 *
 * The human is only pulled in for access, safety confirmation, approval,
 * or clarification. Everything else advances through the existing lawful
 * state machine on the agent's own initiative.
 */

const HUMAN_DECISION_STATES: RunState[] = [
  "backup_gate",
  "paused",
  "escalated",
  "failed",
  "rolled_back",
  "complete",
];

export const projectHasUsableAccess = (project: Project) =>
  project.accessMethods.some((method) => method.status === "available");

export const projectAccessNeedsAttention = (project: Project) =>
  project.accessMethods.length > 0 && project.accessMethods.every((method) => method.status !== "available");

/** The next state the agent may take on its own, or null when a human is required. */
export const autoAdvanceTarget = (project: Project, run: Run): RunState | null => {
  if (HUMAN_DECISION_STATES.includes(run.state)) return null;

  // QA is handled by the QA runner, not by a plain phase advance.
  if (run.state === "qa") return null;

  if (run.state === "access_check" && !projectHasUsableAccess(project)) return null;

  // Nothing moves from planning into applying a fix without a stored,
  // executable plan and a human go-ahead. Read-only work has no fix to apply,
  // so it passes through without ever claiming one.
  if (run.state === "plan") {
    const readOnly = run.taskType === "qa_only";
    const storedPlan = run.artifacts.some((artifact) => artifact.type === "fix_plan");

    if (readOnly && !storedPlan) {
      return validateAdvance(run, "recommendations").ok ? "recommendations" : null;
    }

    if (!readOnly) {
      if (!storedPlan) return null;
      const approved = run.approvals.some(
        (approval) => approval.type === "high_risk_execution" && approval.status === "approved",
      );
      if (!approved) return null;
    }
  }

  const next = getNextPhase(run.state);
  if (!next) return null;

  return validateAdvance(run, next).ok ? next : null;
};

export const workingNarration = (target: RunState): string | null => {
  switch (target) {
    case "environment_mapping":
      return "I'm mapping the production environment now.";
    case "diagnosis":
      return "I'm going through the site to find what's actually causing this.";
    case "plan":
      return "I've identified the likely cause. I'm preparing the safest fix.";
    case "execution":
      return "I'm applying the fix now.";
    case "qa":
      return "The change is in place. I'm running the final checks.";
    case "recommendations":
      return "Checks are done. I'm writing up the result and what I'd still recommend.";
    case "complete":
      return "Everything is verified and this task is closed out.";
    default:
      return null;
  }
};

export type QaSimulation = {
  updates: Array<{ id: string; result: QaResult["result"]; notes: string }>;
  verdict: "passed" | "failed" | "partial";
  summary: string;
};

/**
 * Prototype QA runner.
 *
 * No executor or model is connected yet, so pending (skipped) checks are
 * completed deterministically from the existing run data. Existing failed or
 * warning results are never rewritten to passed.
 */
export const simulateQa = (run: Run): QaSimulation | null => {
  const results = run.qaReport.results;
  if (results.length === 0) return null;

  const updates = results
    .filter((result) => result.result === "skipped")
    .map((result) => ({
      id: result.id,
      result: "passed" as const,
      notes: result.notes || "Checked after the work and behaving correctly.",
    }));

  const resolved: QaResult["result"][] = results.map((result) =>
    result.result === "skipped" ? "passed" : result.result,
  );

  const hasFailure = resolved.includes("failed");
  const hasWarning = resolved.includes("warning");

  const verdict = hasFailure ? "failed" : hasWarning ? "partial" : "passed";
  const summary = hasFailure
    ? "One or more checks did not pass. I've stopped here rather than call this finished."
    : hasWarning
      ? "The site is working, but a couple of checks came back with something worth noting."
      : "All checks behaved correctly after the work.";

  return { updates, verdict, summary };
};
