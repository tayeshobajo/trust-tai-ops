/**
 * Deterministic reduce for windowed meeting analysis.
 *
 * A long transcript is read in windows. Merging those windows is done here, in
 * code, rather than by asking a model to summarise its own output: a second
 * model pass could rewrite a quote, soften a risk grade, or drop the tail it
 * was supposed to preserve. This merge can only combine what the extraction
 * pass already proved against the transcript.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import { LIMITS, RISK_LEVELS, type MeetingAnalysis, type Provenance } from "./meetingSchema.ts";

const key = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const mergeProvenance = (a: Provenance[], b: Provenance[]): Provenance[] => {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const entry of [...a, ...b]) {
    const id = `${entry.chunkIndex}:${key(entry.excerpt)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
    if (out.length >= LIMITS.provenance) break;
  }
  return out;
};

/** Combines items that describe the same thing, keeping the first wording. */
const dedupe = <T>(
  items: T[],
  limit: number,
  identity: (item: T) => string,
  combine: (existing: T, incoming: T) => T,
): T[] => {
  const order: string[] = [];
  const byKey = new Map<string, T>();
  for (const item of items) {
    const id = identity(item);
    if (!id) continue;
    const existing = byKey.get(id);
    if (existing) {
      byKey.set(id, combine(existing, item));
      continue;
    }
    order.push(id);
    byKey.set(id, item);
  }
  return order.slice(0, limit).map((id) => byKey.get(id) as T);
};

const riskRank = (level: string): number => Math.max(0, (RISK_LEVELS as readonly string[]).indexOf(level));

const higherRisk = (a: string, b: string): (typeof RISK_LEVELS)[number] =>
  (riskRank(a) >= riskRank(b) ? a : b) as (typeof RISK_LEVELS)[number];

const earlier = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
};

/**
 * Merges window analyses into one. Every safety property is merged upwards:
 * the highest risk wins, an execution approval required anywhere is required
 * everywhere, and the earliest deadline is the one that stands.
 */
export const mergeMeetingAnalyses = (parts: MeetingAnalysis[]): MeetingAnalysis => {
  const usable = parts.filter(Boolean);
  if (usable.length === 1) return usable[0];

  const summary = usable
    .map((part) => part.summary.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, LIMITS.summary);

  return {
    summary,
    decisions: dedupe(
      usable.flatMap((part) => part.decisions),
      LIMITS.decisions,
      (item) => key(item.statement),
      (existing, incoming) => ({
        ...existing,
        provenance: mergeProvenance(existing.provenance, incoming.provenance),
      }),
    ),
    constraints: dedupe(
      usable.flatMap((part) => part.constraints),
      LIMITS.constraints,
      (item) => key(item.statement),
      (existing, incoming) => ({ ...existing, provenance: mergeProvenance(existing.provenance, incoming.provenance) }),
    ),
    openQuestions: dedupe(
      usable.flatMap((part) => part.openQuestions),
      LIMITS.openQuestions,
      (item) => key(item.question),
      (existing, incoming) => ({ ...existing, provenance: mergeProvenance(existing.provenance, incoming.provenance) }),
    ),
    memoryCandidates: dedupe(
      usable.flatMap((part) => part.memoryCandidates),
      LIMITS.memoryCandidates,
      (item) => key(item.title),
      (existing, incoming) => ({ ...existing, provenance: mergeProvenance(existing.provenance, incoming.provenance) }),
    ),
    proposedTasks: dedupe(
      usable.flatMap((part) => part.proposedTasks),
      LIMITS.proposedTasks,
      (item) => key(item.title),
      (existing, incoming) => ({
        ...existing,
        riskLevel: higherRisk(existing.riskLevel, incoming.riskLevel),
        requiresExecutionApproval: existing.requiresExecutionApproval || incoming.requiresExecutionApproval,
        needsInvestigation: existing.needsInvestigation || incoming.needsInvestigation,
        owner: existing.owner === "unassigned" ? incoming.owner : existing.owner,
        deadlineText: existing.deadlineText || incoming.deadlineText,
        dueDate: earlier(existing.dueDate, incoming.dueDate),
        accessNeeded: Array.from(new Set([...existing.accessNeeded, ...incoming.accessNeeded])).slice(0, 4),
        dependsOn: Array.from(new Set([...existing.dependsOn, ...incoming.dependsOn])).slice(0, 4),
        provenance: mergeProvenance(existing.provenance, incoming.provenance),
      }),
    ),
    supersededMemory: dedupe(
      usable.flatMap((part) => part.supersededMemory),
      LIMITS.supersededMemory,
      (item) => key(item.memoryIdHint),
      (existing, incoming) => ({ ...existing, provenance: mergeProvenance(existing.provenance, incoming.provenance) }),
    ),
  };
};