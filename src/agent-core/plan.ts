/**
 * The agent's living working plan.
 *
 * A run carries exactly one plan: the goal it is pursuing, the hypotheses it
 * is testing, and the ordered steps it intends to take. The plan is revised as
 * facts arrive and is the artefact a person reads to understand — and correct
 * — what the agent currently believes.
 *
 * Everything here is plain English. Tool ids are carried for reconciliation
 * only and are never rendered.
 */

import type { AgentAction, AgentEvidence, ToolId } from "./types";

export type HypothesisStatus = "open" | "supported" | "ruled_out";

export type PlanHypothesis = {
  id: string;
  text: string;
  status: HypothesisStatus;
  note: string;
};

export type PlanStepStatus = "pending" | "active" | "done" | "blocked" | "skipped";

export type PlanStep = {
  id: string;
  label: string;
  toolId: ToolId | null;
  status: PlanStepStatus;
  note: string;
  evidenceId: string | null;
};

export type RunPlan = {
  projectId: string;
  runId: string;
  goal: string;
  hypotheses: PlanHypothesis[];
  steps: PlanStep[];
  revision: number;
  updatedAt: string;
};

export const emptyPlan = (projectId: string, runId: string, goal: string): RunPlan => ({
  projectId,
  runId,
  goal,
  hypotheses: [],
  steps: [],
  revision: 0,
  updatedAt: new Date().toISOString(),
});

/** Steps are keyed by invocation key so a replayed action maps to one step. */
export const stepKeyFor = (action: AgentAction): string => action.invocationKey;

/**
 * Folds the reasoner's intended actions into the plan without losing history:
 * steps already recorded keep their status, new ones are appended as pending.
 */
export const reconcileSteps = (plan: RunPlan, actions: AgentAction[]): RunPlan => {
  const known = new Set(plan.steps.map((step) => step.id));
  const added = actions
    .filter((action) => !known.has(stepKeyFor(action)))
    .map<PlanStep>((action) => ({
      id: stepKeyFor(action),
      label: action.purpose,
      toolId: action.toolId,
      status: "pending",
      note: "",
      evidenceId: null,
    }));
  if (added.length === 0) return plan;
  return { ...plan, steps: [...plan.steps, ...added], revision: plan.revision + 1 };
};

export const markStep = (
  plan: RunPlan,
  stepId: string,
  status: PlanStepStatus,
  note = "",
  evidenceId: string | null = null,
): RunPlan => {
  let changed = false;
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return step;
    changed = true;
    return { ...step, status, note: note || step.note, evidenceId: evidenceId ?? step.evidenceId };
  });
  if (!changed) return plan;
  return { ...plan, steps, revision: plan.revision + 1 };
};

export const setGoal = (plan: RunPlan, goal: string): RunPlan =>
  goal && goal !== plan.goal ? { ...plan, goal, revision: plan.revision + 1 } : plan;

/** Adds hypotheses the plan has not seen before. Matching is on normalized text. */
export const addHypotheses = (plan: RunPlan, texts: string[]): RunPlan => {
  const seen = new Set(plan.hypotheses.map((item) => item.text.trim().toLowerCase()));
  const added = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && !seen.has(text.toLowerCase()))
    .map<PlanHypothesis>((text, index) => ({
      id: `h${plan.hypotheses.length + index + 1}`,
      text,
      status: "open",
      note: "",
    }));
  if (added.length === 0) return plan;
  return { ...plan, hypotheses: [...plan.hypotheses, ...added], revision: plan.revision + 1 };
};

export const resolveHypothesis = (
  plan: RunPlan,
  id: string,
  status: HypothesisStatus,
  note = "",
): RunPlan => {
  let changed = false;
  const hypotheses = plan.hypotheses.map((item) => {
    if (item.id !== id || item.status === status) return item;
    changed = true;
    return { ...item, status, note: note || item.note };
  });
  if (!changed) return plan;
  return { ...plan, hypotheses, revision: plan.revision + 1 };
};

/**
 * Evidence resolves hypotheses only when it names them. A hypothesis is never
 * closed because a tool happened to succeed — that is how agents fool
 * themselves. The link is an explicit keyword overlap with the observation.
 */
export const applyEvidence = (plan: RunPlan, evidence: AgentEvidence): RunPlan => {
  const haystack = `${evidence.summary} ${JSON.stringify(evidence.data ?? {})}`.toLowerCase();
  return plan.hypotheses.reduce((current, hypothesis) => {
    if (hypothesis.status !== "open") return current;
    const terms = hypothesis.text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 4);
    if (terms.length === 0) return current;
    const hits = terms.filter((term) => haystack.includes(term)).length;
    if (hits / terms.length < 0.5) return current;
    return resolveHypothesis(current, hypothesis.id, "supported", evidence.summary);
  }, plan);
};

export const openSteps = (plan: RunPlan): PlanStep[] =>
  plan.steps.filter((step) => step.status === "pending" || step.status === "active");

export const isPlanEmpty = (plan: RunPlan): boolean =>
  plan.steps.length === 0 && plan.hypotheses.length === 0 && plan.goal.trim().length === 0;
