import type { Project, Run } from "./types";
import { getActiveRun } from "./lib";

export const HUMAN_PHASES = [
  "Understanding",
  "Investigating",
  "Planning",
  "Resolving",
  "Checking",
  "Completed",
] as const;
export type HumanPhase = (typeof HUMAN_PHASES)[number];

/**
 * Work that only reads never plans or applies a fix, so it must never show a
 * phase that promises one. Audits, reviews and verification runs go
 * Understanding → Investigating → Checking → Completed.
 */
export const READ_ONLY_PHASES: HumanPhase[] = ["Understanding", "Investigating", "Checking", "Completed"];

export const isReadOnlyTask = (run: Run): boolean => run.taskType === "qa_only";

/** A stored, executable fix plan is the only thing that licenses "Resolving". */
export const hasStoredFixPlan = (run: Run): boolean =>
  run.artifacts.some((artifact) => artifact.type === "fix_plan");

/** The phase track a given task actually travels through. */
export const phasesForRun = (run: Run | null): readonly HumanPhase[] =>
  run && isReadOnlyTask(run) && !hasStoredFixPlan(run) ? READ_ONLY_PHASES : HUMAN_PHASES;

export type AgentState = "ready" | "working" | "needs_you";

export type ProjectSignal = {
  status: string;
  detail: string;
  phase: HumanPhase | null;
  agentState: AgentState;
  needsYou: string | null;
  updatedAt: string;
};

const shortTitle = (run: Run) => run.title.replace(/\.$/, "").toLowerCase();

export const signalForRun = (run: Run): ProjectSignal => {
  const base = { updatedAt: run.updatedAt } as const;
  // A read-only task with nothing to apply never claims to be fixing anything.
  const readOnly = isReadOnlyTask(run) && !hasStoredFixPlan(run);

  switch (run.state) {
    case "intake":
      return { ...base, status: "Getting the task set up", detail: run.taskSummary, phase: "Understanding", agentState: "working", needsYou: null };
    case "access_check":
      return { ...base, status: "Waiting for access details", detail: run.operatorPrompt || "The agent needs access before it can look at the site.", phase: "Understanding", agentState: "needs_you", needsYou: run.nextAction };
    case "backup_gate":
      return { ...base, status: "Waiting for backup confirmation", detail: run.operatorPrompt || "A safe restore point is needed before any change.", phase: "Investigating", agentState: "needs_you", needsYou: run.nextAction };
    case "environment_mapping":
    case "diagnosis":
      return { ...base, status: `Investigating ${shortTitle(run)}`, detail: run.diagnosisSummary || run.taskSummary, phase: "Investigating", agentState: "working", needsYou: null };
    case "plan":
      if (readOnly) {
        return { ...base, status: `Investigating ${shortTitle(run)}`, detail: run.diagnosisSummary || run.taskSummary, phase: "Investigating", agentState: "working", needsYou: null };
      }
      return run.approvalRequired
        ? { ...base, status: `Needs your go-ahead on ${shortTitle(run)}`, detail: run.planSummary || run.operatorPrompt, phase: "Planning", agentState: "needs_you", needsYou: run.nextAction }
        : { ...base, status: `Working out the safest fix for ${shortTitle(run)}`, detail: run.planSummary || run.taskSummary, phase: "Planning", agentState: "working", needsYou: null };
    case "execution":
      if (readOnly) {
        return { ...base, status: `Checking ${shortTitle(run)}`, detail: run.diagnosisSummary || run.taskSummary, phase: "Checking", agentState: "working", needsYou: null };
      }
      return { ...base, status: `Applying the fix for ${shortTitle(run)}`, detail: run.planSummary || run.taskSummary, phase: "Resolving", agentState: "working", needsYou: null };
    case "qa":
      return { ...base, status: "Running final checks", detail: run.qaReport.summary || "Verifying the site behaves correctly after the work.", phase: "Checking", agentState: "working", needsYou: null };
    case "recommendations":
      return { ...base, status: "Writing up what it found", detail: "The agent is turning this task into clear follow-ups and project memory.", phase: "Checking", agentState: "working", needsYou: null };
    case "complete":
      return { ...base, status: "Task completed", detail: run.qaReport.summary || "The work is finished and verified.", phase: "Completed", agentState: "ready", needsYou: null };
    case "paused":
      return { ...base, status: "Paused until you reply", detail: run.operatorPrompt || "The agent stopped on purpose and is waiting on you.", phase: "Investigating", agentState: "needs_you", needsYou: run.nextAction };
    case "escalated":
    case "failed":
      return { ...base, status: "Needs your decision", detail: run.operatorPrompt || "Something needs a human call before the agent continues.", phase: "Investigating", agentState: "needs_you", needsYou: run.nextAction };
    case "rolled_back":
      return { ...base, status: "Changes were rolled back", detail: run.operatorPrompt || "The agent restored the previous state to keep the site safe.", phase: "Checking", agentState: "needs_you", needsYou: run.nextAction };
    default:
      return { ...base, status: "Working on your task", detail: run.taskSummary, phase: "Investigating", agentState: "working", needsYou: null };
  }
};

export const getProjectSignal = (project: Project): ProjectSignal => {
  const run = getActiveRun(project);

  if (!run) {
    return {
      status: "Ready for a new task",
      detail: "Tell the agent what is happening on this site and it will take it from there.",
      phase: null,
      agentState: "ready",
      needsYou: null,
      updatedAt: "",
    };
  }

  return signalForRun(run);
};

export const getProjectInitials = (project: Project) =>
  project.name
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "TT";

export const formatActivityStamp = (stamp: string) => {
  if (!stamp) {
    return "";
  }

  const match = stamp.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);

  if (!match) {
    return stamp;
  }

  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();

  if (sameDay) {
    return `${hour}:${minute}`;
  }

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const getActivityTimestamp = (project: Project) => {
  const run = getActiveRun(project);
  return run?.updatedAt ?? "";
};

export const sortProjectsByActivity = (projects: Project[]) =>
  [...projects].sort((a, b) => getActivityTimestamp(b).localeCompare(getActivityTimestamp(a)));

export const getRecentActivity = (project: Project, limit = 3) => {
  const run = getActiveRun(project);

  if (!run) {
    return [] as string[];
  }

  return [...run.actions].reverse().slice(0, limit).map((action) => action.summary);
};

export const getMemoryHighlights = (project: Project, limit = 3) => {
  const weight = { critical: 0, high: 1, medium: 2 } as const;

  return [...project.memoryEntries]
    .sort((a, b) => weight[a.importance] - weight[b.importance])
    .slice(0, limit);
};
