/**
 * Evidence helpers.
 *
 * Findings must be grounded. Nothing in the conversation may claim something
 * that no tool actually observed, so every user-facing sentence in this file is
 * derived from a piece of AgentEvidence.
 */

import { safeSummary } from "./safety";
import type { AgentEvidence, ToolId } from "./types";

export const evidenceFor = (evidence: AgentEvidence[], toolId: ToolId): AgentEvidence | null =>
  evidence.find((item) => item.toolId === toolId) ?? null;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** Compact context for a reasoner. Structured, already redacted. */
export const toReasonerContext = (evidence: AgentEvidence[]): string[] =>
  evidence.map((item) => `${item.toolId}: ${item.summary}`);

/** What the agent may say to a person about a public site check. */
export const describeSiteInspection = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const status = num(data.status);
  const ms = num(data.durationMs);
  const finalUrl = str(data.finalUrl);
  const title = str(data.title);
  const lines: string[] = [];

  if (status === null) {
    return [safeSummary(evidence.summary)];
  }

  if (status >= 200 && status < 300) {
    lines.push(
      ms !== null
        ? `I checked the public site and it responded normally, in about ${(ms / 1000).toFixed(1)}s.`
        : "I checked the public site and it responded normally.",
    );
  } else if (status >= 300 && status < 400) {
    lines.push(`The public site is redirecting${finalUrl ? ` and lands on ${finalUrl}` : ""}.`);
  } else if (status >= 500) {
    lines.push(`The public site is returning a server error (${status}). That is a real fault, not a slow page.`);
  } else {
    lines.push(`The public site answered with ${status}.`);
  }

  if (title) lines.push(`The page it served is "${title}".`);
  return lines;
};

/** What the agent may say about the public WordPress surface. */
export const describePublicSurface = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const restAvailable = data.restApiAvailable === true;
  const name = str(data.siteName);
  const generator = str(data.generator);
  const lines: string[] = [];

  lines.push(
    restAvailable
      ? `The WordPress public interface is reachable${name ? ` for "${name}"` : ""}.`
      : "The WordPress public interface is not reachable from outside, so I can only see the page itself for now.",
  );
  if (generator) lines.push(`The site reports itself as ${generator}.`);
  return lines;
};

/** A run finding, but only when the evidence actually justifies one. */
export const findingFromEvidence = (
  evidence: AgentEvidence,
): { severity: "low" | "medium" | "high" | "critical"; title: string; summary: string } | null => {
  const status = num(evidence.data.status);
  if (status === null) return null;
  if (status >= 500) {
    return {
      severity: "high",
      title: "Public site is returning a server error",
      summary: safeSummary(`The site answered with ${status} when checked from outside.`),
    };
  }
  const ms = num(evidence.data.durationMs);
  if (ms !== null && ms > 4000) {
    return {
      severity: "medium",
      title: "Public site is slow to respond",
      summary: safeSummary(`The first response took about ${(ms / 1000).toFixed(1)}s from outside.`),
    };
  }
  return null;
};
