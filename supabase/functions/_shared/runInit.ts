/**
 * Server-side run initialization for approved meeting proposals.
 *
 * The browser used to compute the shape of a new run and write it. It no
 * longer does either. The entry state of a run decides whether a backup gate
 * or an access check stands in front of production work, so it is computed
 * here, from facts the server established, and never accepted from a caller.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

export type RunSeedInput = {
  title: string;
  taskType: string;
  taskSummary: string;
  environmentId: string;
  /** Project has at least one usable access path, as read from the server. */
  accessReady: boolean;
  /** Meeting proposals never arrive with a confirmed restore point. */
  backupConfirmed: boolean;
  /** The proposal's own risk grade, already hardened by the validator. */
  riskLevel: string;
  /** True when the validator kept a human execution approval in front of the work. */
  requiresExecutionApproval: boolean;
};

export type RunSeed = {
  environment_id: string;
  title: string;
  task_type: string;
  task_summary: string;
  urgency: string;
  state: string;
  risk_level: string;
  backup_status: string;
  approval_required: boolean;
  next_action: string;
  operator_prompt: string;
  diagnosis_summary: string;
  plan_summary: string;
};

const READ_ONLY_TASK_TYPES = new Set(["qa_only"]);

/**
 * A run born from a meeting opens at the first gate it cannot clear on its own:
 * access truth first, then restore readiness, and only then evidence gathering.
 */
export const runEntryState = (input: RunSeedInput): string => {
  if (!input.accessReady) return "access_check";
  if (READ_ONLY_TASK_TYPES.has(input.taskType) && input.riskLevel === "safe") return "environment_mapping";
  return input.backupConfirmed ? "environment_mapping" : "backup_gate";
};

export const buildRunSeed = (input: RunSeedInput): RunSeed => {
  const state = runEntryState(input);
  const readOnly = READ_ONLY_TASK_TYPES.has(input.taskType) && input.riskLevel === "safe";

  return {
    environment_id: input.environmentId,
    title: input.title.slice(0, 160) || "Work from a client meeting",
    task_type: input.taskType,
    task_summary: input.taskSummary.slice(0, 2000) || input.title,
    urgency: "normal",
    state,
    risk_level: input.riskLevel,
    backup_status: input.backupConfirmed ? "confirmed_by_operator" : "unconfirmed",
    // A meeting can raise this bar and never lower it.
    approval_required: input.requiresExecutionApproval || input.riskLevel === "high_risk",
    next_action:
      state === "access_check"
        ? "Confirm which access paths this work needs before anything is inspected."
        : state === "backup_gate"
          ? "Confirm a usable restore point before any write-capable step exists."
          : "Map the environment and load project memory before forming a diagnosis.",
    operator_prompt:
      state === "access_check"
        ? "Share the access this needs, and I'll take it from there."
        : state === "backup_gate"
          ? "Tell me a restore point exists and I'll continue."
          : "I'll gather evidence first and come back with what I found.",
    diagnosis_summary:
      state === "environment_mapping"
        ? readOnly
          ? "This starts as a read-only pass so the work is understood before anything changes."
          : "Diagnosis has not been formed yet. Evidence is still being gathered."
        : "Diagnosis is intentionally blocked until the current gate clears.",
    plan_summary: "No execution plan yet. This came from a meeting and still has to earn one.",
  };
};