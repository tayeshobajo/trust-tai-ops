/**
 * Failure taxonomy and escalation ladder.
 *
 * A failure is not a thing to retry — it is a thing to classify. The class
 * decides the response, so the same error is never attempted three times in a
 * row while the agent waits for a different universe.
 */

import type { ToolFailureCode, ToolId } from "./types";

export type FailureClass = "transient" | "permission" | "environment" | "logic" | "policy";

const CLASS_BY_CODE: Record<ToolFailureCode, FailureClass> = {
  timeout: "transient",
  network_error: "transient",

  unauthorized: "permission",
  forbidden: "permission",
  capability_unavailable: "permission",
  secret_store_unavailable: "permission",

  execution_backend_unavailable: "environment",
  execution_context_unavailable: "environment",
  tool_unavailable: "environment",
  not_implemented: "environment",

  invalid_input: "logic",
  unsafe_destination: "logic",

  blocked_by_policy: "policy",
};

export const classifyFailure = (code: ToolFailureCode): FailureClass => CLASS_BY_CODE[code] ?? "environment";

/** Attempts allowed per class before the ladder moves on. */
const MAX_ATTEMPTS: Record<FailureClass, number> = {
  transient: 2,
  permission: 1,
  environment: 1,
  logic: 1,
  policy: 1,
};

export type Escalation =
  | { action: "retry"; delayMs: number }
  | { action: "alternate_route"; reason: string }
  | { action: "ask_human"; need: "access" | "approval"; reason: string }
  | { action: "stop"; reason: string };

/**
 * @param attempts how many times this exact action has already been tried.
 */
export const escalate = (code: ToolFailureCode, attempts: number): Escalation => {
  const failureClass = classifyFailure(code);
  const budget = MAX_ATTEMPTS[failureClass];

  if (failureClass === "transient" && attempts < budget) {
    // Linear, not exponential: a turn has a wall-clock ceiling to respect.
    return { action: "retry", delayMs: 750 * attempts };
  }

  switch (failureClass) {
    case "permission":
      return {
        action: "ask_human",
        need: code === "forbidden" ? "approval" : "access",
        reason: "The step needs access this project has not granted yet.",
      };
    case "environment":
    case "transient":
      return { action: "alternate_route", reason: "That route is unavailable. Trying a different one." };
    case "logic":
      return { action: "alternate_route", reason: "That step was malformed. Reaching the same fact another way." };
    case "policy":
    default:
      return { action: "stop", reason: "A safety rule stopped this step." };
  }
};

/**
 * Repeated failures of the same class across *different* tools mean the whole
 * route is dead, not just one step. Three is the line.
 */
export const routeIsExhausted = (
  history: Array<{ toolId: ToolId; code: ToolFailureCode }>,
  failureClass: FailureClass,
): boolean => history.filter((item) => classifyFailure(item.code) === failureClass).length >= 3;
