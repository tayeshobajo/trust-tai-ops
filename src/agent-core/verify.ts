/**
 * Per-step verification.
 *
 * The end-of-run QA phase asks "did the task work?". This asks a smaller and
 * more important question after every single action: "did that step actually
 * produce the signal it claimed it would?".
 *
 * Without this, a tool that returns successfully but observes nothing counts
 * as progress, and the agent walks confidently off a cliff. A step is not
 * complete until its own evidence is checked.
 */

import type { AgentAction, AgentEvidence, ToolId } from "./types";

export type StepVerdict = "verified" | "inconclusive" | "contradicted";

export type StepVerification = {
  verdict: StepVerdict;
  /** Plain English. Safe to show a person and safe to store in the plan. */
  note: string;
};

/**
 * The signal each tool exists to produce. If an observation does not carry at
 * least one of these fields, the tool ran but answered nothing.
 */
const EXPECTED_SIGNAL: Record<ToolId, string[]> = {
  "public_http.inspect_site": ["status", "statusCode", "reachable"],
  "browser.inspect_page_readonly": ["status", "timing", "metrics", "consoleErrors"],
  "wordpress.inspect_public_surface": ["wordpressDetected", "generator", "restApiAvailable"],
  "wordpress.list_plugins": ["plugins"],
  "wordpress.read_health": ["checks", "authenticatedHealthAvailable", "phpVersion", "wordpressVersion"],
  "wordpress.read_error_log": ["lines", "entries", "logFound"],
  "wordpress.run_wp_cli_readonly": ["stdout", "rows", "output"],
  "wordpress.execute_wp_cli": ["stdout", "output"],
  "filesystem.read": ["contents", "contentHash"],
  "filesystem.write": ["written", "contentHash"],
  "database.query_readonly": ["rows", "contentHash"],
  "database.execute": ["rowsAffected"],
};

const hasSignal = (data: Record<string, unknown>, fields: string[]): boolean =>
  fields.some((field) => {
    const value = data[field];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return true; // an empty array is still an answer
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "object") return Object.keys(value as object).length > 0;
    return true;
  });

/**
 * Checks one completed action against the evidence it produced.
 *
 * This deliberately does not judge whether the news was good. A site returning
 * 500 is a verified observation. Verification is about whether the agent
 * actually looked, not about whether it liked what it saw.
 */
export const verifyStep = (action: AgentAction, evidence: AgentEvidence[]): StepVerification => {
  const mine = evidence.filter((item) => item.toolId === action.toolId);

  if (mine.length === 0) {
    return {
      verdict: "inconclusive",
      note: "The step ran but returned nothing I can rely on, so I haven't counted it.",
    };
  }

  const expected = EXPECTED_SIGNAL[action.toolId] ?? [];
  const answered = mine.some((item) => hasSignal(item.data ?? {}, expected));

  if (expected.length > 0 && !answered) {
    return {
      verdict: "inconclusive",
      note: "The step completed without producing the reading it was meant to produce.",
    };
  }

  // A mutating step must prove it landed, not merely that it was accepted.
  if (!action.readOnly) {
    const landed = mine.some((item) => {
      const data = item.data ?? {};
      return data.verified === true || data.applied === true || hasSignal(data, ["contentHash", "rowsAffected"]);
    });
    if (!landed) {
      return {
        verdict: "contradicted",
        note: "The change was accepted but I couldn't confirm it actually took effect.",
      };
    }
  }

  return { verdict: "verified", note: mine[0].summary };
};