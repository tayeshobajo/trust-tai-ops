/**
 * Server-side conversation retrieval.
 *
 * The browser may say what a person typed. It may never say what the project
 * remembers. Every candidate here is loaded through an injected store that the
 * edge function backs with a service-role read *after* project authorization,
 * so a caller cannot smuggle in a fabricated "you said" line.
 *
 * Ranking is deterministic and explainable: exact anchor, then alias, then
 * lexical overlap with a temporal and recency bias. No embeddings, no hidden
 * scoring, and a hard budget so an old project cannot outgrow the model.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import { normalizeLabel } from "./anchors.ts";
import { referenceIntent, type ReferenceIntent } from "./reference.ts";

export type AnchorRecord = {
  id: string;
  runId: string | null;
  sourceMessageId: string;
  anchorType: string;
  label: string;
  normalizedLabel: string;
  aliases: string[];
  summary: string;
  createdAt: string;
  runTitle?: string | null;
};

export type MessageRecord = {
  id: string;
  runId: string | null;
  role: string;
  text: string;
  createdAt: string;
  runTitle?: string | null;
};

export type ContinuityStore = {
  listAnchors: (projectId: string) => Promise<AnchorRecord[]>;
  searchMessages: (projectId: string, terms: string[], limit: number) => Promise<MessageRecord[]>;
};

export type RetrievedReference = {
  anchorId: string | null;
  sourceMessageId: string;
  sourceRunId: string | null;
  label: string | null;
  summary: string;
  createdAt: string;
  method: ResolutionMethod;
  confidence: number;
};

export type ResolutionMethod = "anchor_exact" | "anchor_alias" | "lexical" | "temporal" | "none";

export type ContinuityResult = {
  status: "not_needed" | "resolved" | "ambiguous" | "not_found";
  intent: ReferenceIntent;
  references: RetrievedReference[];
  /** Present for `ambiguous` and `not_found`: what to ask, in plain English. */
  question: string | null;
  charCount: number;
};

export const MAX_REFERENCES = 4;
export const REFERENCE_CHARS = 320;
export const RETRIEVAL_BUDGET = 1_800;
export const SEARCH_LIMIT = 60;

const DAY = 86_400_000;

const clean = (value: string, max = REFERENCE_CHARS): string =>
  (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const ageDays = (createdAt: string, now: number): number => {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) ? Math.max(0, (now - at) / DAY) : 999;
};

/** Plain-English placement, so a clarifying question can name each candidate. */
export const whenLabel = (createdAt: string, now: number): string => {
  const days = ageDays(createdAt, now);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 8) return "last week";
  if (days < 60) return "last month";
  return "earlier in this project";
};

const withinTemporal = (createdAt: string, now: number, hint: ReferenceIntent["temporal"]): boolean => {
  if (!hint) return false;
  const days = ageDays(createdAt, now);
  if (hint === "yesterday") return days >= 0.5 && days <= 2.5;
  if (hint === "last_week") return days >= 1 && days <= 16;
  return true;
};

const asReference = (
  anchor: AnchorRecord,
  method: ResolutionMethod,
  confidence: number,
): RetrievedReference => ({
  anchorId: anchor.id,
  sourceMessageId: anchor.sourceMessageId,
  sourceRunId: anchor.runId,
  label: anchor.label,
  summary: clean(anchor.summary),
  createdAt: anchor.createdAt,
  method,
  confidence,
});

const budgeted = (references: RetrievedReference[]): { references: RetrievedReference[]; charCount: number } => {
  const out: RetrievedReference[] = [];
  let used = 0;
  for (const reference of references.slice(0, MAX_REFERENCES)) {
    const size = reference.summary.length + (reference.label?.length ?? 0);
    if (used + size > RETRIEVAL_BUDGET) break;
    out.push(reference);
    used += size;
  }
  return { references: out, charCount: used };
};

const describe = (anchor: AnchorRecord, now: number): string => {
  const where = anchor.runTitle ? `on "${clean(anchor.runTitle, 60)}"` : "in this project";
  return `${anchor.label} ${where} (${whenLabel(anchor.createdAt, now)}): ${clean(anchor.summary, 140)}`;
};

const scoreMessage = (message: MessageRecord, intent: ReferenceIntent, runId: string | null, now: number): number => {
  const haystack = message.text.toLowerCase();
  let score = 0;
  for (const term of intent.terms) if (haystack.includes(term)) score += 1;
  if (score === 0) return 0;
  if (withinTemporal(message.createdAt, now, intent.temporal)) score += 1.5;
  if (intent.temporal && !withinTemporal(message.createdAt, now, intent.temporal)) score -= 0.5;
  if (runId && message.runId === runId) score += 0.5;
  score += Math.max(0, 0.5 - ageDays(message.createdAt, now) / 120);
  return score;
};

/**
 * Resolve a backward reference against project history, or refuse to guess.
 *
 * The refusal is the feature: an unresolved pointer becomes one short question,
 * never an assumed instruction.
 */
export const resolveContinuity = async (
  input: { projectId: string; runId: string | null; text: string; now?: number },
  store: ContinuityStore,
): Promise<ContinuityResult> => {
  const now = input.now ?? Date.now();
  const intent = referenceIntent(input.text);
  if (!intent.needsRecall) {
    return { status: "not_needed", intent, references: [], question: null, charCount: 0 };
  }

  const anchors = await store.listAnchors(input.projectId);
  const options = anchors.filter((anchor) => anchor.anchorType === "option");

  let candidates: AnchorRecord[] = [];
  let method: ResolutionMethod = "none";

  if (intent.label) {
    const wanted = normalizeLabel(intent.label);
    candidates = options.filter((anchor) => anchor.normalizedLabel === wanted);
    method = "anchor_exact";
  } else if (intent.ordinal >= 0) {
    const wanted = new Set([`${["first", "second", "third", "fourth", "fifth"][intent.ordinal]} option`]);
    candidates = options.filter((anchor) => anchor.aliases.some((alias) => wanted.has(alias)));
    method = "anchor_alias";
  }

  if (candidates.length > 0) {
    // Same wording offered twice is the same offer; different wording is a real
    // fork and the person has to say which.
    const distinct = new Map<string, AnchorRecord>();
    for (const anchor of [...candidates].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
      const key = clean(anchor.summary, 120).toLowerCase();
      if (!distinct.has(key)) distinct.set(key, anchor);
    }
    const unique = [...distinct.values()];

    if (unique.length === 1) {
      const { references, charCount } = budgeted([asReference(unique[0], method, method === "anchor_exact" ? 0.95 : 0.85)]);
      return { status: "resolved", intent, references, question: null, charCount };
    }

    const shortlist = unique.slice(0, 3);
    return {
      status: "ambiguous",
      intent,
      references: shortlist.map((anchor) => asReference(anchor, method, 0.4)),
      question: [
        `I've offered ${intent.label ?? "that choice"} more than once in this project, and they weren't the same thing.`,
        "Which one do you mean?",
        ...shortlist.map((anchor) => `- ${describe(anchor, now)}`),
      ].join("\n"),
      charCount: 0,
    };
  }

  if (intent.terms.length === 0) {
    if (intent.label) {
      return {
        status: "not_found",
        intent,
        references: [],
        question: `I can't find where I offered ${intent.label} in this project, so I don't want to assume what it was. Could you tell me what it should cover?`,
        charCount: 0,
      };
    }
    return {
      status: "not_found",
      intent,
      references: [],
      question:
        "I want to be sure I pick up the right thread rather than guess. Which piece of earlier work do you mean?",
      charCount: 0,
    };
  }

  const messages = await store.searchMessages(input.projectId, intent.terms, SEARCH_LIMIT);
  const ranked = messages
    .map((message) => ({ message, score: scoreMessage(message, intent, input.runId, now) }))
    .filter((entry) => entry.score >= 1)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      status: "not_found",
      intent,
      references: [],
      question: intent.label
        ? `I can't find where I offered ${intent.label} in this project, so I don't want to assume what it was. Could you tell me what it should cover?`
        : "I couldn't find the earlier discussion you're pointing at, and I'd rather ask than assume. What should I pick back up?",
      charCount: 0,
    };
  }

  const { references, charCount } = budgeted(
    ranked.map((entry) => ({
      anchorId: null,
      sourceMessageId: entry.message.id,
      sourceRunId: entry.message.runId,
      label: entry.message.runTitle ? clean(entry.message.runTitle, 60) : null,
      summary: clean(entry.message.text),
      createdAt: entry.message.createdAt,
      method: (intent.temporal ? "temporal" : "lexical") as ResolutionMethod,
      confidence: Math.min(0.8, 0.4 + entry.score / 10),
    })),
  );

  return { status: "resolved", intent, references, question: null, charCount };
};