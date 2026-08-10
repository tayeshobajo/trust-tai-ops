import type { NewProjectMessage, Organization, Project, ProjectMessage, Run, RunState } from "./types";
import { autoAdvanceTarget, simulateQa, workingNarration } from "./agent";
import { workspaceRepository } from "./repository";

/**
 * Agent executor bridge.
 *
 * Everything the agent says while it works on its own goes through here, so a
 * single place owns:
 *  - task/run association (every emission carries the run it belongs to)
 *  - idempotency (deterministic dedupe keys derived from run id + step, never
 *    from wall-clock time, so a rerender, remount, or replayed step cannot
 *    create a second copy of the same line)
 *
 * When a real executor replaces the prototype planner, it emits through
 * `AgentEmit` with the same key discipline and the conversation record stays
 * correct without any change to the workspace.
 */

export type AgentEmit = (input: NewProjectMessage) => Promise<ProjectMessage | null>;

export type AgentStepContext = {
  project: Project;
  run: Run;
  emit: AgentEmit;
  onWorkspaceUpdate: (next: Organization) => void;
};

export type AgentStepResult = { ran: boolean };

/** Deterministic key for anything the agent says about a given step of a run. */
export const agentStepKey = (runId: string, step: string): string => `agent-step-${runId}-${step}`;

/** Identity of the work the agent is about to do. Stable across rerenders. */
export const agentStepIdentity = (project: Project, run: Run): string | null => {
  if (run.state === "qa") return simulateQa(run) ? `${run.id}:qa:${run.qaReport.verdict}` : null;
  const target = autoAdvanceTarget(project, run);
  return target ? `${run.id}:${run.state}:${target}` : null;
};

const sayStep = async (context: AgentStepContext, step: string, body: string[], kind: NewProjectMessage["kind"]) => {
  const lines = body.filter((line) => line.trim().length > 0);
  if (lines.length === 0) return;
  await context.emit({
    runId: context.run.id,
    role: "agent",
    kind,
    body: lines,
    dedupeKey: agentStepKey(context.run.id, step),
  });
};

const runQaStep = async (context: AgentStepContext): Promise<AgentStepResult> => {
  const { project, run } = context;
  const simulation = simulateQa(run);
  if (!simulation) return { ran: false };

  for (const update of simulation.updates) {
    await workspaceRepository.updateQaResult(project.id, run.id, update.id, update.result, update.notes);
  }

  let next = await workspaceRepository.setQaVerdict(project.id, run.id, simulation.verdict, simulation.summary);

  // The agent reports the outcome of its own checks in the conversation.
  await sayStep(context, `qa-${simulation.verdict}`, [simulation.summary], "status_update");

  if (simulation.verdict !== "failed") {
    next = await workspaceRepository.advanceRun(project.id, run.id, "recommendations");
  }

  context.onWorkspaceUpdate(next);
  return { ran: true };
};

const runAdvanceStep = async (context: AgentStepContext, target: RunState): Promise<AgentStepResult> => {
  const narration = workingNarration(target);
  if (narration) {
    await sayStep(context, target, [narration], "status_update");
  }
  context.onWorkspaceUpdate(await workspaceRepository.advanceRun(context.project.id, context.run.id, target));
  return { ran: true };
};

/**
 * Perform the next step the agent may take on its own, appending whatever it
 * says to the persisted conversation for that exact run.
 */
export const executeAgentStep = async (context: AgentStepContext): Promise<AgentStepResult> => {
  if (context.run.state === "qa") return runQaStep(context);
  const target = autoAdvanceTarget(context.project, context.run);
  if (!target) return { ran: false };
  return runAdvanceStep(context, target);
};
