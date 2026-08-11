/**
 * Deterministic duplicate and conflict detection for meeting proposals.
 *
 * Clients repeat themselves. The same request appears in three meetings, and
 * the second and third must not silently become second and third runs. This
 * module decides, in code rather than in a model, whether a proposal is
 * already being handled, is related to open work, or contradicts something the
 * project has already committed to.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "on", "in", "is", "are", "be", "we", "our",
  "it", "this", "that", "with", "from", "by", "at", "as", "site", "website", "page", "wordpress",
  "please", "should", "need", "needs", "want", "wants", "fix", "issue", "problem",
]);

export const tokenize = (value: string): Set<string> =>
  new Set(
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );

/** Jaccard overlap on meaningful words. Deterministic and explainable. */
export const similarity = (a: string, b: string): number => {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
};

/** Same work, already running. */
export const DUPLICATE_THRESHOLD = 0.6;
/** Adjacent work worth mentioning, not worth blocking. */
export const RELATED_THRESHOLD = 0.32;

export type ExistingWork = { id: string; title: string; summary?: string; open: boolean };

export type MatchVerdict = {
  duplicateOfRunId: string | null;
  relatedRunId: string | null;
  note: string;
};

/**
 * A duplicate is only ever reported against work that is still open. Repeating
 * a request after a run finished is a legitimate new ask, not a duplicate.
 */
export const matchProposalToWork = (proposalText: string, existing: ExistingWork[]): MatchVerdict => {
  let best: { work: ExistingWork; score: number } | null = null;
  for (const work of existing) {
    const score = similarity(proposalText, `${work.title} ${work.summary ?? ""}`);
    if (!best || score > best.score) best = { work, score };
  }

  if (!best || best.score < RELATED_THRESHOLD) return { duplicateOfRunId: null, relatedRunId: null, note: "" };

  if (best.work.open && best.score >= DUPLICATE_THRESHOLD) {
    return {
      duplicateOfRunId: best.work.id,
      relatedRunId: null,
      note: `This looks like work already underway: "${best.work.title}".`,
    };
  }

  return {
    duplicateOfRunId: null,
    relatedRunId: best.work.id,
    note: `Related to "${best.work.title}".`,
  };
};

const PROHIBITION =
  /\b(never|do not|don't|must not|cannot|can't|no longer|avoid|forbidden|not allowed|under no circumstances)\b/i;

export type MemoryFact = { id: string; title: string; content: string };

/**
 * Surfaces a durable memory that reads as a standing prohibition against this
 * proposal. It does not block anything: it gives the human the sentence they
 * need in order to decide, which is the only place that decision belongs.
 */
export const detectMemoryConflict = (proposalText: string, memory: MemoryFact[]): string => {
  const proposalWords = tokenize(proposalText);
  if (proposalWords.size === 0) return "";

  for (const fact of memory) {
    const text = `${fact.title}. ${fact.content}`;
    if (!PROHIBITION.test(text)) continue;
    const factWords = tokenize(text);
    let shared = 0;
    for (const word of proposalWords) if (factWords.has(word)) shared += 1;
    // Two meaningful words in common with a standing "never do this" is enough
    // to be worth a sentence in front of a human.
    if (shared >= 2) return `This may conflict with what the project already decided: ${fact.title}.`;
  }
  return "";
};