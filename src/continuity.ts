/**
 * Conversation continuity — browser side.
 *
 * The browser decides one thing only: whether a message *looks* like it points
 * back at something already said, so it knows to ask the server. It never
 * decides what the reference resolved to. That answer is loaded from stored
 * history on the server, where nobody can fabricate a "you said this earlier".
 *
 * `referenceIntent` here mirrors the server parser in
 * `supabase/functions/_shared/continuity/reference.ts`; `npm run check:continuity`
 * asserts the two agree on the whole fixture corpus.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "./env";
import { getSupabaseClient } from "./supabase";

const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth"] as const;

export type LocalReferenceIntent = {
  needsRecall: boolean;
  label: string | null;
  ordinal: number;
  reason: string;
};

const TEMPORAL = /\b(yesterday|last (week|month)|earlier|before|previously|the other day|last time)\b/i;

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

const termsOf = (text: string): string[] => {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((word) => !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 12);
};

export const referenceIntent = (raw: string): LocalReferenceIntent => {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const none: LocalReferenceIntent = { needsRecall: false, label: null, ordinal: -1, reason: "self_contained" };
  if (text.length === 0 || text.length > 600) return none;

  const labelMatch = text.match(/\boption\s+([A-Da-d])\b/i) ?? text.match(/^\s*([A-Da-d])\)\s*$/);
  if (labelMatch) {
    return { needsRecall: true, label: `Option ${labelMatch[1].toUpperCase()}`, ordinal: -1, reason: "explicit_label" };
  }

  const ordinalMatch = text.match(
    new RegExp(`\\b(?:the\\s+)?(${ORDINAL_WORDS.join("|")})\\s+(one|option|approach|plan|path|choice)\\b`, "i"),
  );
  if (ordinalMatch) {
    return {
      needsRecall: true,
      label: null,
      ordinal: ORDINAL_WORDS.indexOf(ordinalMatch[1].toLowerCase() as (typeof ORDINAL_WORDS)[number]),
      reason: "ordinal",
    };
  }

  if (POINTER_PATTERNS.some((pattern) => pattern.test(text))) {
    return { needsRecall: true, label: null, ordinal: -1, reason: "pointer_phrase" };
  }

  if (TEMPORAL.test(text) && termsOf(text).length <= 3) {
    return { needsRecall: true, label: null, ordinal: -1, reason: "temporal_only" };
  }

  return none;
};

export type ResolvedReference = {
  label: string | null;
  summary: string;
  when: string;
  method: string;
  confidence: number;
  sourceRunId: string | null;
};

export type ContinuityOutcome = {
  status: "not_needed" | "resolved" | "ambiguous" | "not_found" | "unavailable";
  question: string | null;
  references: ResolvedReference[];
};

const UNAVAILABLE: ContinuityOutcome = { status: "unavailable", question: null, references: [] };

export const continuityAvailable = (): boolean => hasSupabasePublicConfig(resolveOpsEnv());

/**
 * Records any labelled choice this stored message offered, so it can be named
 * later. Fire-and-forget: a missed anchor degrades to a history search, never
 * to a wrong answer.
 */
export const indexConversationAnchors = async (projectId: string, messageId: string): Promise<void> => {
  if (!continuityAvailable()) return;
  try {
    await getSupabaseClient().functions.invoke("conversation-continuity", {
      body: { mode: "index", projectId, messageId },
    });
  } catch {
    /* Indexing is an optimisation, never a gate on the conversation. */
  }
};

/** Asks the server what an already-stored message referred back to. */
export const resolveReference = async (projectId: string, messageId: string): Promise<ContinuityOutcome> => {
  if (!continuityAvailable()) return UNAVAILABLE;
  try {
    const { data, error } = await getSupabaseClient().functions.invoke("conversation-continuity", {
      body: { mode: "resolve", projectId, messageId },
    });
    const payload = (data ?? {}) as { ok?: boolean; status?: string; question?: string | null; references?: unknown };
    if (error || !payload.ok) return UNAVAILABLE;
    return {
      status: (payload.status as ContinuityOutcome["status"]) ?? "not_needed",
      question: payload.question ?? null,
      references: Array.isArray(payload.references) ? (payload.references as ResolvedReference[]) : [],
    };
  } catch {
    return UNAVAILABLE;
  }
};

/** One quiet line of provenance: what the agent decided this pointed at. */
export const provenanceLine = (references: ResolvedReference[]): string | null => {
  const top = references[0];
  if (!top) return null;
  const named = top.label ? `${top.label}` : "what we discussed";
  return `Picking up ${named} from ${top.when}: ${top.summary}`;
};