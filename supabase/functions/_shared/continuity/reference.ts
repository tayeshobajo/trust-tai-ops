/**
 * Backward-reference detection.
 *
 * "option B", "do the second one", "same as yesterday" are not requests: they
 * are pointers at something already said. Detecting them is what stops the
 * agent from inventing a task called "option B", and stops a self-contained
 * request from paying for a history search it does not need.
 *
 * Conservative on purpose. A false negative costs a normal turn; a false
 * positive stalls a clear instruction behind a clarification.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import { ORDINAL_WORDS } from "./anchors.ts";

export type TemporalHint = "yesterday" | "last_week" | "earlier" | null;

export type ReferenceIntent = {
  needsRecall: boolean;
  /** An explicit label the person named, e.g. "Option B". */
  label: string | null;
  /** 0-based position when they named a position instead of a label. */
  ordinal: number;
  temporal: TemporalHint;
  /** Terms worth searching history for, already stripped of pointer words. */
  terms: string[];
  reason: string;
};

const TEMPORAL_PATTERNS: Array<{ hint: Exclude<TemporalHint, null>; pattern: RegExp }> = [
  { hint: "yesterday", pattern: /\byesterday\b/i },
  { hint: "last_week", pattern: /\blast (week|month)\b/i },
  { hint: "earlier", pattern: /\b(earlier|before|previously|the other day|last time|already discussed)\b/i },
];

/** Phrases that only make sense against something already in the project. */
const POINTER_PATTERNS: RegExp[] = [
  /\b(that|those|this|the same|the safer|the safest|the riskier|the cheaper|the quicker|the other)\s+(approach|option|plan|path|route|setting|settings|one|way|fix|idea)\b/i,
  /\bsame as (yesterday|before|last time|we discussed|what we discussed)\b/i,
  /\bcontinue (where we left off|from (where|what) we)\b/i,
  /\bpick up where we left off\b/i,
  /\b(what|which) did we (decide|agree|choose|pick)\b/i,
  /\b(do|go with|use|apply|proceed with) what we (agreed|decided|discussed|chose)\b/i,
  /\b(as|like) (we )?(discussed|agreed|planned)\b/i,
  /\bthe one (we|you|i) (discussed|mentioned|suggested|proposed)\b/i,
  /\bgo ahead with (that|it|the plan)\b/i,
  /\b(carry on|resume|continue) (with )?(that|it|the plan|where)\b/i,
];

const STOPWORDS = new Set([
  "the", "and", "that", "with", "this", "have", "from", "they", "will", "would", "there", "their", "what",
  "about", "which", "when", "should", "could", "into", "just", "like", "make", "need", "want", "please",
  "yesterday", "week", "month", "last", "earlier", "before", "previously", "again", "same", "your", "you",
  "option", "options", "one", "ones", "lets", "let", "then", "them", "those", "these", "discussed", "agreed",
  "decide", "decided", "continue", "left", "off", "where", "were", "been", "does", "did", "use", "using",
  ...ORDINAL_WORDS,
]);

export const referenceTerms = (text: string): string[] => {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((word) => !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 12);
};

const temporalOf = (text: string): TemporalHint =>
  TEMPORAL_PATTERNS.find((entry) => entry.pattern.test(text))?.hint ?? null;

const NOT_NEEDED: ReferenceIntent = {
  needsRecall: false,
  label: null,
  ordinal: -1,
  temporal: null,
  terms: [],
  reason: "self_contained",
};

/**
 * The single decision this module exists to make: does answering this message
 * require looking further back than the current context window?
 */
export const referenceIntent = (raw: string): ReferenceIntent => {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > 600) return NOT_NEEDED;

  const temporal = temporalOf(text);
  const terms = referenceTerms(text);

  const labelMatch = text.match(/\boption\s+([A-Da-d])\b/i) ?? text.match(/^\s*([A-Da-d])\)\s*$/);
  if (labelMatch) {
    const letter = labelMatch[1].toUpperCase();
    return { needsRecall: true, label: `Option ${letter}`, ordinal: -1, temporal, terms, reason: "explicit_label" };
  }

  const ordinalMatch = text.match(
    new RegExp(`\\b(?:the\\s+)?(${ORDINAL_WORDS.join("|")})\\s+(one|option|approach|plan|path|choice)\\b`, "i"),
  );
  if (ordinalMatch) {
    return {
      needsRecall: true,
      label: null,
      ordinal: ORDINAL_WORDS.indexOf(ordinalMatch[1].toLowerCase() as (typeof ORDINAL_WORDS)[number]),
      temporal,
      terms,
      reason: "ordinal",
    };
  }

  if (POINTER_PATTERNS.some((pattern) => pattern.test(text))) {
    return { needsRecall: true, label: null, ordinal: -1, temporal, terms, reason: "pointer_phrase" };
  }

  // A bare temporal reference is only a pointer when the message carries no
  // request of its own: "what we sized up yesterday" versus "deploy tomorrow's
  // release yesterday's way" — the latter still says what to do.
  if (temporal && terms.length <= 3) {
    return { needsRecall: true, label: null, ordinal: -1, temporal, terms, reason: "temporal_only" };
  }

  return NOT_NEEDED;
};

export const needsConversationRecall = (text: string): boolean => referenceIntent(text).needsRecall;