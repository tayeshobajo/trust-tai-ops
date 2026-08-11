/**
 * Autonomy budgets.
 *
 * The agent may keep investigating on its own, but never without a ceiling.
 * Every bound that stops a loop lives here, in one place, so the limits are
 * auditable rather than scattered through the orchestrator.
 */

/** Reasoning iterations allowed in a single turn. */
export const MAX_AGENT_ITERATIONS = 8;

/** Wall-clock ceiling for one turn. */
export const MAX_AGENT_WALL_CLOCK_MS = 90_000;

/** Retries allowed for one action that failed with a retryable error. */
export const MAX_ACTION_RETRIES = 1;

/** Consecutive iterations without new evidence before the agent stops. */
export const MAX_ITERATIONS_WITHOUT_PROGRESS = 2;
