import type { MemoryEntry, NewProjectMessage, Organization, Project, ProjectMessage, Run, RunState } from "./types";
import { autoAdvanceTarget, simulateQa, workingNarration } from "./agent";
import { workspaceRepository } from "./repository";
import { runAgentTurn } from "./agent-core/orchestrator";
import type { AgentEvidence } from "./agent-core/types";
import { executionGateway } from "./agent-core/gateway";
import { getProjectStack } from "./stacks";
import { looksLikeQuestion, replyLines, streamAgentReply, voiceAvailable } from "./agent-core/voice";
import { hostGuidanceFact } from "./hostGuidance";

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
  /** Renders the reply as it is written, before it is persisted. */
  onStream?: (soFar: string) => void;
  /** Facts this turn observed, for the site-health readout. */
  onEvidence?: (learned: AgentEvidence[]) => void;
};

/**
 * Seeded demo runs predate the execution kernel and have no real site behind
 * them, so they keep the deterministic display behaviour. Every run created in
 * the product goes through the real kernel and never fabricates a result.
 */
const LEGACY_RUN_IDS = new Set(["run-epay-speed", "run-bluehole-qa"]);

const isLegacyRun = (run: Run) => LEGACY_RUN_IDS.has(run.id);

export type AgentStepResult = { ran: boolean };

/**
 * One turn, spoken in the agent's own voice.
 *
 * The kernel's own sentences are correct but robotic, so they are collected
 * rather than said: they become the facts sheet a model writes the actual
 * reply from. If the model is unreachable, the collected sentences are said
 * exactly as before — terse, never wrong.
 */
const speakTurn = async (
  context: AgentStepContext,
  keyPrefix: string,
): Promise<{ spoke: boolean; awaiting: string | null; stopReason: string | null }> => {
  const collected: string[] = [];
  const collect: AgentEmit = async (input) => {
    if (input.role === "agent") {
      collected.push(...input.body);
      return null;
    }
    return context.emit(input);
  };

  const turn = await runAgentTurn({
    project: context.project,
    run: context.run,
    recentMessages: context.recentMessages ?? [],
    memory: context.memory ?? [],
    emit: voiceAvailable() ? collect : context.emit,
    onWorkspaceUpdate: context.onWorkspaceUpdate,
  });

  if (turn.learned.length > 0) context.onEvidence?.(turn.learned);

  if (!voiceAvailable()) {
    return { spoke: turn.acted, awaiting: turn.awaiting, stopReason: turn.stopReason ?? null };
  }

  const say = async (body: string[]) => {
    const lines = body.filter((line) => line.trim().length > 0);
    if (lines.length === 0) return false;
    await context.emit({
      runId: context.run.id,
      role: "agent",
      kind: "message",
      body: lines,
      dedupeKey: `${keyPrefix}-${context.run.id}-${collected.length}-${lines.join(" ").length}`,
    });
    return true;
  };

  const recent = (context.recentMessages ?? []).filter((message) => message.role === "user");
  const latest = recent[recent.length - 1]?.body.join(" ") ?? "";
  const capabilities = await executionGateway().projectCapabilities(context.project.id);

  let written = "";
  try {
    written = await streamAgentReply(
      context.project.id,
      {
        stack: getProjectStack(context.project),
        taskTitle: context.run.title ?? "",
        taskType: context.run.taskType,
        siteKnown: Boolean(context.project.primaryDomain),
        question: latest,
        isQuestion: looksLikeQuestion(latest),
        storedAccess: capabilities.stored,
        verifiedAccess: capabilities.verified,
        observations: turn.learned.map((item) => item.summary),
        kernelLines: collected,
        awaiting: turn.awaiting,
        recentAgentLines: (context.recentMessages ?? [])
          .filter((message) => message.role === "agent")
          .slice(-4)
          .map((message) => message.body.join(" ")),
        memory: [
          ...(context.memory ?? []).slice(-5).map((entry) => `${entry.title}: ${entry.content}`),
          hostGuidanceFact(context.project) ?? "",
        ].filter(Boolean),
      },
      context.onStream,
    );
  } catch {
    written = "";
  }

  const lines = replyLines(written);
  const spoke = lines.length > 0 ? await say(lines) : collected.length > 0 ? await say(collected) : false;

  return { spoke: spoke || turn.acted, awaiting: turn.awaiting, stopReason: turn.stopReason ?? null };
};

/**
 * A message from a person is a reason to think, not a reason to acknowledge.
 *
 * Every plain message on a real run opens an agent turn: the reasoner reads
 * what was just said alongside everything already observed, revises the plan,
 * and investigates with read-only tools. Returns whether the agent actually
 * said something, so the caller only falls back to a composed reply when the
 * kernel had nothing real to contribute.
 */
export const respondToUserMessage = async (
  context: AgentStepContext,
): Promise<{ spoke: boolean; awaiting: string | null }> => {
  if (isLegacyRun(context.run)) return { spoke: false, awaiting: null };

  try {
    const turn = await speakTurn(context, "reply");
    return { spoke: turn.spoke, awaiting: turn.awaiting };
  } catch {
    // The kernel failing must never swallow the person's message.
    return { spoke: false, awaiting: null };
  }
};

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
  const turn = await speakTurn(context, "step");

  // Waiting on the human (access, backup, approval) is a real stop, not a step.
  if (turn.awaiting) return { ran: true };
  // A turn that ended by asking the person something is also a real stop: the
  // run must not slide forward while the question is unanswered.
  if (turn.stopReason === "needs_user_input") return { ran: true };

  const target = autoAdvanceTarget(context.project, context.run);
  if (!target) return { ran: turn.spoke };
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
