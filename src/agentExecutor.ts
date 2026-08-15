import type { MemoryEntry, NewProjectMessage, Organization, Project, ProjectMessage, Run, RunState } from "./types";
import { autoAdvanceTarget, simulateQa, workingNarration } from "./agent";
import { workspaceRepository } from "./repository";
import { runAgentTurn } from "./agent-core/orchestrator";
import type { AgentEvidence } from "./agent-core/types";
import { executionGateway } from "./agent-core/gateway";
import type { FixPlanResult, GatewayRequest } from "./agent-core/gateway";
import type { KBDigest } from "./types";
import { getProjectStack } from "./stacks";
import { looksLikeQuestion, replyLines, streamAgentReply, voiceAvailable } from "./agent-core/voice";
import { hostGuidanceFact } from "./hostGuidance";
import { detectConstraints, constraintAlreadyStored } from "./agent-core/constraints";

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

  // Prior incidents, fetched once per turn. Task-type match first; the library
  // is global so one project's fix is every project's starting point.
  let knowledgeBase: KBDigest[] = [];
  try {
    const entries = await workspaceRepository.listKnowledgeBase(context.project.id, context.run.taskType);
    const globals = entries.length > 0 ? entries : await workspaceRepository.listKnowledgeBase(context.project.id);
    knowledgeBase = (globals.length > 0 ? globals : entries).slice(0, 6).map((entry) => ({
      symptom: entry.symptomPattern,
      resolution: entry.resolution,
      evidenceSignals: entry.evidenceSignals.slice(0, 3),
      host: entry.hostContext,
    }));
  } catch {
    // The library is an enhancement. Unreachable means empty.
  }

  const turn = await runAgentTurn({
    project: context.project,
    run: context.run,
    recentMessages: context.recentMessages ?? [],
    memory: context.memory ?? [],
    emit: voiceAvailable() ? collect : context.emit,
    onWorkspaceUpdate: context.onWorkspaceUpdate,
    knowledgeBase,
  });

  if (turn.learned.length > 0) context.onEvidence?.(turn.learned);

  // Diagnosis synthesis: when the investigation stopped because it learned
  // enough, ask the server reasoner for the causal chain — the "why", not
  // the "what". Failure never breaks the turn; the closeout already said
  // the truth in plain words.
  if (turn.stopReason === "sufficient_evidence" && turn.learned.length > 0) {
    try {
      const synthesis = await executionGateway().synthesize(context.project.id, {
        stack: getProjectStack(context.project),
        taskType: context.run.taskType,
        taskTitle: context.run.title ?? "",
        symptom: context.run.taskSummary || context.run.title || "",
        evidence: turn.learned.slice(-40).map((item) => `${item.toolId}: ${item.summary}`),
        hypotheses: [],
        constraints: (context.memory ?? [])
          .filter((entry) => entry.type === "constraint")
          .slice(-12)
          .map((entry) => entry.content),
        doneTools: [...new Set(turn.learned.map((item) => item.toolId))],
      });
      if (synthesis?.ok && synthesis.synthesis) {
        await context.emit({
          runId: context.run.id,
          role: "agent",
          kind: "status_update",
          body: [synthesis.synthesis.slice(0, 4000)],
          dedupeKey: `synthesis-${context.run.id}`,
        });
        await workspaceRepository.addEvidence(
          context.project.id,
          context.run.id,
          "scan_result",
          "Diagnosis synthesis",
          synthesis.synthesis.slice(0, 400),
        );
      }
    } catch {
      // The synthesis is an enhancement. The run already closed out truthfully.
    }

    // Fix-plan: after diagnosis, ask the reasoner what write steps to take.
    // The plan is stored and emitted as a fix_plan event so the UI can render
    // the confirmation card. Best-effort — never breaks the turn.
    try {
      const capabilities = await executionGateway().projectCapabilities(context.project.id);
      const synthesisText = await workspaceRepository
        .getRecentEvidence(context.project.id, context.run.id, "scan_result", 1)
        .then((rows) => rows[0]?.summary ?? "")
        .catch(() => "");

      const fixPlan: FixPlanResult | null = await executionGateway().planFix(context.project.id, {
        stack: getProjectStack(context.project),
        taskType: context.run.taskType,
        taskTitle: context.run.title ?? "",
        symptom: context.run.taskSummary || context.run.title || "",
        diagnosis: synthesisText,
        evidence: turn.learned.slice(-20).map((item) => `${item.toolId}: ${item.summary}`),
        constraints: (context.memory ?? [])
          .filter((entry) => entry.type === "constraint")
          .slice(-8)
          .map((entry) => entry.content),
        capabilities: [...capabilities.verified, ...capabilities.stored],
      });

      if (fixPlan && fixPlan.steps.length > 0) {
        // Emit the plan so the UI can render the confirmation card.
        await context.emit({
          runId: context.run.id,
          role: "agent",
          kind: "fix_plan",
          body: [
            `Here\'s what I can do to fix this:`,
            `${fixPlan.rationale}`,
            ...fixPlan.steps.map((s, i) => `${i + 1}. ${s.label}`),
            `Risk level: ${fixPlan.risk}.`,
            !fixPlan.canAutoExecute || fixPlan.risk !== "low"
              ? "This requires your approval before I proceed."
              : "I can run this automatically if you\'d like.",
          ],
          dedupeKey: `fix-plan-${context.run.id}`,
        });

        // Store the fix plan as pending evidence so the orchestrator can
        // retrieve it when the user approves.
        await workspaceRepository.addEvidence(
          context.project.id,
          context.run.id,
          "fix_plan",
          "Proposed fix plan",
          JSON.stringify(fixPlan).slice(0, 2000),
        );

        // Advance the run to the plan state so the UI shows the approval card.
        await workspaceRepository.advanceRun(context.project.id, context.run.id, "plan").catch(() => undefined);
      }
    } catch {
      // Fix planning is an enhancement. The diagnosis already closed out.
    }
  }

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

  // Lift standing rules out of what the person just said — before thinking
  // about anything else. A constraint stated once must never need repeating.
  const latest = (context.recentMessages ?? []).filter((m) => m.role === "user").at(-1);
  if (latest) {
    const text = latest.body.join(" ");
    const found = detectConstraints(text);
    const existing = context.memory ?? [];
    for (const candidate of found) {
      if (constraintAlreadyStored(existing, candidate)) continue;
      try {
        await workspaceRepository.addMemoryEntry(context.project.id, {
          title: candidate.title,
          content: candidate.content,
          type: "constraint",
          importance: candidate.importance,
          sourceMessageId: latest.id,
        });
      } catch {
        // A failed write must never stop the conversation.
      }
    }
  }

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
 * Execute an approved fix plan.
 *
 * Reads the stored fix_plan artifact, runs each write step through the gateway
 * in order, takes a backup snapshot for any step marked backupFirst, and emits
 * a status line per step. When all steps complete (or a step fails), the run
 * advances to "qa" for re-observation. Failure is reported truthfully; nothing
 * is fabricated.
 */
const executeFixPlan = async (context: AgentStepContext): Promise<AgentStepResult> => {
  const { project, run } = context;

  // Retrieve the fix plan we stored when the plan was proposed.
  let fixPlan: FixPlanResult | null = null;
  try {
    const rows = await workspaceRepository.getRecentEvidence(
      project.id,
      run.id,
      "fix_plan",
      1,
    );
    if (rows[0]?.summary) {
      fixPlan = JSON.parse(rows[0].summary) as FixPlanResult;
    }
  } catch {
    // If the plan is unreadable, bail out gracefully.
  }

  if (!fixPlan || fixPlan.steps.length === 0) {
    await sayStep(
      context,
      "execute-no-plan",
      ["I couldn't find a stored fix plan for this run. Please re-run diagnosis."],
      "status_update",
    );
    return { ran: true };
  }

  await sayStep(
    context,
    "execute-start",
    [`Starting fix execution — ${fixPlan.steps.length} step${fixPlan.steps.length === 1 ? "" : "s"}.`],
    "status_update",
  );

  let allOk = true;
  const gateway = executionGateway();

  for (const step of fixPlan.steps) {
    // Backup snapshot before any destructive step.
    if (step.backupFirst) {
      try {
        const backupReq: GatewayRequest = {
          projectId: project.id,
          runId: run.id,
          actionId: `backup-before-${step.stepId}`,
          toolId: "wordpress.sftp_write_file" as GatewayRequest["toolId"],
          invocationKey: `backup-${run.id}-${step.stepId}`,
          args: { _op: "snapshot_before", targetStepId: step.stepId },
        };
        const backupResult = await gateway.invoke(backupReq);
        if (backupResult.ok) {
          await workspaceRepository.addEvidence(
            project.id,
            run.id,
            "backup_note",
            `Backup before: ${step.label}`,
            backupResult.summary.slice(0, 400),
          );
        }
      } catch {
        // A failed backup snapshot is noteworthy but not a blocker by default.
      }
    }

    // Execute the step.
    const req: GatewayRequest = {
      projectId: project.id,
      runId: run.id,
      actionId: step.stepId,
      toolId: step.toolId as GatewayRequest["toolId"],
      invocationKey: `exec-${run.id}-${step.stepId}`,
      args: step.args,
    };

    let result: Awaited<ReturnType<typeof gateway.invoke>>;
    try {
      result = await gateway.invoke(req);
    } catch {
      result = {
        ok: false,
        code: "execution_backend_unavailable",
        summary: "Step failed — gateway unreachable.",
        retryable: true,
      };
    }

    // Emit step outcome.
    const statusLine = result.ok
      ? `✓ ${step.label}: ${result.summary.slice(0, 200)}`
      : `✗ ${step.label}: ${result.summary.slice(0, 200)}`;

    await sayStep(
      context,
      `execute-step-${step.stepId}`,
      [statusLine],
      "status_update",
    );

    // Store a diff_summary for the step.
    await workspaceRepository
      .addEvidence(
        project.id,
        run.id,
        "diff_summary",
        `Step result: ${step.label}`,
        result.summary.slice(0, 400),
      )
      .catch(() => undefined);

    if (!result.ok) {
      allOk = false;
      // Hard failure on a high-risk step: stop immediately.
      if (step.risk === "high") break;
    }
  }

  const summaryLine = allOk
    ? `All ${fixPlan.steps.length} fix steps completed. Moving to QA verification.`
    : "One or more fix steps failed. Moving to QA to assess the site state.";

  await sayStep(context, "execute-done", [summaryLine], "status_update");

  // Advance to QA regardless of outcome — the re-observation tells the truth.
  try {
    const next = await workspaceRepository.advanceRun(project.id, run.id, "qa");
    context.onWorkspaceUpdate(next);
  } catch {
    // Advance failure is bookkeeping — the steps already ran.
  }

  return { ran: true };
};

/**
 * QA for a real run.
 *
 * Runs the same investigation kernel used during diagnosis — reading what the
 * site currently does — so a QA turn is a real re-observation, not a ceremony.
 * The run stays in `qa` until the kernel has re-observed the site, is not
 * waiting on the human, and is not blocked. Nothing here invents a passing
 * verdict: what gets said is exactly what the re-observation showed.
 */
const runRealQaStep = async (context: AgentStepContext): Promise<AgentStepResult> => {
  const turn = await speakTurn(context, "qa");

  const investigationCompleted =
    turn.spoke &&
    !turn.awaiting &&
    turn.stopReason !== "needs_user_input" &&
    turn.stopReason !== "needs_access";

  if (investigationCompleted) {
    try {
      const next = await workspaceRepository.advanceRun(context.project.id, context.run.id, "recommendations");
      context.onWorkspaceUpdate(next);
    } catch {
      // The phase advance is bookkeeping; the re-observation was already said.
    }
  }

  return { ran: turn.spoke };
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

  if (!legacy && context.run.state === "execution") {
    return executeFixPlan(context);
  }

  if (!legacy && INVESTIGATION_STATES.includes(context.run.state)) {
    return runInvestigationStep(context);
  }

  const target = autoAdvanceTarget(context.project, context.run);
  if (!target) return { ran: false };
  return runAdvanceStep(context, target);
};
