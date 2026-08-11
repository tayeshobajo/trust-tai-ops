import type { MemoryEntry, NewProjectMessage, Organization, Project, ProjectMessage, Run, RunState } from "./types";
import { autoAdvanceTarget, simulateQa, workingNarration } from "./agent";
import { workspaceRepository } from "./repository";
import { runAgentTurn } from "./agent-core/orchestrator";

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
  /** Conversation so far for this run. Used as reasoning context. */
  recentMessages?: ProjectMessage[];
  memory?: MemoryEntry[];
};

/**
 * Seeded demo runs predate the execution kernel and have no real site behind
 * them, so they keep the deterministic display behaviour. Every run created in
 * the product goes through the real kernel and never fabricates a result.
 */
const LEGACY_RUN_IDS = new Set(["run-epay-speed", "run-bluehole-qa"]);

const isLegacyRun = (run: Run) => LEGACY_RUN_IDS.has(run.id);

export type AgentStepResult = { ran: boolean };

/** Deterministic key for anything the agent says about a given step of a run. */
export const agentStepKey = (runId: string, step: string): string => `auto-${runId}-${step}`;

/** Identity of the work the agent is about to do. Stable across rerenders. */
export const agentStepIdentity = (project: Project, run: Run): string | null => {
  if (run.state === "qa") {
    if (!isLegacyRun(run)) return `${run.id}:qa:unverified`;
    return simulateQa(run) ? `${run.id}:qa:${run.qaReport.verdict}` : null;
  }
  if (!isLegacyRun(run) && INVESTIGATION_STATES.includes(run.state)) {
    return `${run.id}:investigate:${run.state}`;
  }
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

/** States where the agent should look at the real site before moving on. */
const INVESTIGATION_STATES: RunState[] = ["intake", "access_check", "environment_mapping", "diagnosis"];

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
 * QA for a real run. Nothing here invents a passing result: if the checks
 * cannot actually be performed yet, the agent says so and the run stays where
 * it is, reflecting only what is genuinely known.
 */
const runRealQaStep = async (context: AgentStepContext): Promise<AgentStepResult> => {
  await sayStep(
    context,
    "qa-unverified",
    [
      "I can't verify this end to end yet — I don't have the access I'd need to re-test the change properly.",
      "I'd rather leave it open than tell you it's confirmed when it isn't.",
    ],
    "status_update",
  );
  return { ran: true };
};

/**
 * Investigation for a real run: the orchestrator decides, real read-only tools
 * execute server-side, and the agent reports only what they observed.
 */
const runInvestigationStep = async (context: AgentStepContext): Promise<AgentStepResult> => {
  const turn = await runAgentTurn({
    project: context.project,
    run: context.run,
    recentMessages: context.recentMessages ?? [],
    memory: context.memory ?? [],
    emit: context.emit,
    onWorkspaceUpdate: context.onWorkspaceUpdate,
  });

  // Waiting on the human (access, backup, approval) is a real stop, not a step.
  if (turn.awaiting) return { ran: true };
  // A turn that ended by asking the person something is also a real stop: the
  // run must not slide forward while the question is unanswered.
  if (turn.stopReason === "needs_user_input") return { ran: true };

  const target = autoAdvanceTarget(context.project, context.run);
  if (!target) return { ran: turn.acted };
  return runAdvanceStep(context, target);
};

/**
 * Perform the next step the agent may take on its own, appending whatever it
 * says to the persisted conversation for that exact run.
 */
export const executeAgentStep = async (context: AgentStepContext): Promise<AgentStepResult> => {
  const legacy = isLegacyRun(context.run);

  if (context.run.state === "qa") {
    return legacy ? runQaStep(context) : runRealQaStep(context);
  }

  if (!legacy && INVESTIGATION_STATES.includes(context.run.state)) {
    return runInvestigationStep(context);
  }

  const target = autoAdvanceTarget(context.project, context.run);
  if (!target) return { ran: false };
  return runAdvanceStep(context, target);
};
