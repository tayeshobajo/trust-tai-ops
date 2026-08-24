import { phaseOrder, stateCopy } from "./data";
import type { PhaseStatus, Run, RunState } from "./types";

/**
 * Ops Trust Tai — Run State Machine
 *
 * Enforces guardrails during run advancement.
 * A run moves through lawful phases in order. Each transition
 * is validated against backup, approval, and QA rules.
 */

export const LAWFUL_TRANSITIONS: Record<RunState, RunState[]> = {
  intake: ["access_check", "paused"],
  access_check: ["backup_gate", "environment_mapping", "paused", "escalated"],
  backup_gate: ["environment_mapping", "paused", "escalated"],
  environment_mapping: ["diagnosis", "paused", "escalated"],
  diagnosis: ["plan", "paused", "escalated", "failed"],
  plan: ["execution", "recommendations", "paused", "escalated"],
  execution: ["qa", "paused", "escalated", "failed", "rolled_back"],
  qa: ["recommendations", "complete", "paused", "rolled_back"],
  recommendations: ["complete", "paused"],
  complete: [],
  paused: ["intake", "access_check", "backup_gate", "environment_mapping", "diagnosis", "plan", "execution", "qa", "recommendations"],
  escalated: ["diagnosis", "plan", "paused", "failed"],
  failed: ["intake", "diagnosis", "plan", "rolled_back"],
  rolled_back: ["environment_mapping", "diagnosis", "paused", "escalated", "complete"],
};

export interface AdvanceResult {
  ok: boolean;
  newState: RunState;
  run: Run;
  guardrailMessage?: string;
  requiresApproval?: boolean;
}

export function canTransitionTo(currentState: RunState, targetState: RunState): boolean {
  const allowed = LAWFUL_TRANSITIONS[currentState] ?? [];
  return allowed.includes(targetState);
}

export function getNextPhase(currentState: RunState): RunState | null {
  const currentIndex = phaseOrder.indexOf(currentState);
  if (currentIndex === -1 || currentIndex >= phaseOrder.length - 1) return null;
  return phaseOrder[currentIndex + 1];
}

export function getPreviousPhase(currentState: RunState): RunState | null {
  const currentIndex = phaseOrder.indexOf(currentState);
  if (currentIndex <= 0) return null;
  return phaseOrder[currentIndex - 1];
}

export interface GuardrailCheck {
  ok: boolean;
  message: string;
}

export function checkBackupGate(run: Run): GuardrailCheck {
  if (run.backupStatus === "unconfirmed") {
    return {
      ok: false,
      message: "Backup gate: restore readiness must be confirmed before advancing.",
    };
  }
  return { ok: true, message: "Backup posture confirmed." };
}

export function checkApprovalGate(run: Run): GuardrailCheck {
  if (run.riskLevel === "high_risk" && run.approvalRequired) {
    const hasApproved = run.approvals.some(
      (a) => a.type === "high_risk_execution" && a.status === "approved",
    );
    if (!hasApproved) {
      return {
        ok: false,
        message: "Approval required: high-risk execution needs explicit operator approval.",
      };
    }
  }
  return { ok: true, message: "Approval posture satisfied." };
}

export function checkQaGate(run: Run): GuardrailCheck {
  if (run.qaReport.verdict === "failed") {
    return {
      ok: false,
      message: "QA gate: QA verdict is 'failed'. Resolve issues or waive before completing.",
    };
  }
  if (run.qaReport.verdict === "partial") {
    const allSkipped = run.qaReport.results.every((r) => r.result === "skipped");
    if (!allSkipped) {
      return {
        ok: false,
        message: "QA gate: some checks are incomplete. Complete or waive them before completing.",
      };
    }
  }
  return { ok: true, message: "QA posture satisfied." };
}

export function validateAdvance(run: Run, targetState: RunState): GuardrailCheck & { requiresApproval?: boolean } {
  if (!canTransitionTo(run.state, targetState)) {
    return {
      ok: false,
      message: `Cannot transition from '${run.state}' to '${targetState}'.`,
    };
  }

  // Backup gate: must have backup before environment_mapping for non-qa_only
  if (targetState === "environment_mapping" && run.state === "backup_gate") {
    const backupCheck = checkBackupGate(run);
    if (!backupCheck.ok) return backupCheck;
  }

  // Execution: approval check
  if (targetState === "execution") {
    const approvalCheck = checkApprovalGate(run);
    if (!approvalCheck.ok) {
      return { ...approvalCheck, requiresApproval: true };
    }
  }

  // Complete: QA gate
  if (targetState === "complete") {
    const qaCheck = checkQaGate(run);
    if (!qaCheck.ok) return qaCheck;
  }

  return { ok: true, message: "Transition allowed." };
}

export function advanceRunState(run: Run, targetState: RunState): Run {
  const check = validateAdvance(run, targetState);
  if (!check.ok) {
    return run;
  }

  const phases = run.phases.map((phase) => {
    const phaseIndex = phaseOrder.indexOf(phase.state);
    const targetIndex = phaseOrder.indexOf(targetState);

    let status: PhaseStatus = "pending";
    if (phaseIndex < targetIndex) status = "completed";
    else if (phaseIndex === targetIndex) status = "active";

    return { ...phase, status };
  });

  // If transitioning to complete, mark all remaining as completed
  if (targetState === "complete") {
    phases.forEach((phase) => {
      if (phase.status === "active") phase.status = "completed";
    });
  }

  return {
    ...run,
    state: targetState,
    phases,
    updatedAt: new Date().toISOString(),
    nextAction: stateCopy[targetState].tone,
  };
}

/**
 * Generate a context payload for an agent operating on this run.
 * This is the structured brief an AI agent would receive.
 */
export function buildAgentContext(run: Run, projectName: string, projectDomain: string): string {
  const lines: string[] = [
    `# Agent Context — ${run.title}`,
    `Project: ${projectName} (${projectDomain})`,
    `Run Type: ${run.taskType}`,
    `Risk Level: ${run.riskLevel}`,
    `Current State: ${run.state}`,
    `Backup Status: ${run.backupStatus}`,
    ``,
    `## Task`,
    run.taskSummary,
    ``,
    `## Guardrail`,
    stateCopy[run.state].guardrail,
    ``,
    `## Next Action`,
    run.nextAction,
    ``,
    `## Operator Prompt`,
    run.operatorPrompt,
  ];

  if (run.diagnosisSummary) {
    lines.push("", "## Diagnosis", run.diagnosisSummary);
  }

  if (run.planSummary) {
    lines.push("", "## Plan", run.planSummary);
  }

  if (run.findings.length > 0) {
    lines.push("", "## Findings");
    run.findings.forEach((f) => {
      lines.push(`- [${f.severity}] ${f.title}: ${f.summary}`);
    });
  }

  if (run.actions.length > 0) {
    lines.push("", "## Action Log");
    run.actions.forEach((a) => {
      lines.push(`- [${a.actor}] ${a.summary} (${a.outcome})`);
    });
  }

  if (run.artifacts.length > 0) {
    lines.push("", "## Evidence");
    run.artifacts.forEach((a) => {
      lines.push(`- [${a.type}] ${a.title}: ${a.summary}`);
    });
  }

  if (run.qaReport.results.length > 0) {
    lines.push("", "## QA Status");
    lines.push(`Verdict: ${run.qaReport.verdict}`);
    run.qaReport.results.forEach((r) => {
      lines.push(`- [${r.result}] ${r.name}: ${r.notes}`);
    });
  }

  return lines.join("\n");
}
