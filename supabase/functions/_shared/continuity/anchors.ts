/**
 * Conversation anchors.
 *
 * When the agent offers a person a labelled choice, that label becomes a
 * durable reference object. Months later "Option B" can then be resolved
 * without an embedding, a model, or a session.
 *
 * The parser is deliberately conservative: it only creates an anchor when the
 * wording is actually present, and it never invents a choice that was not
 * offered. A missed anchor degrades to lexical search; a fabricated anchor
 * would let the agent act on something nobody said.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

export type AnchorType = "option_set" | "option" | "decision" | "commitment" | "reference";

export type AnchorDraft = {
  anchorType: AnchorType;
  label: string;
  normalizedLabel: string;
  aliases: string[];
  summary: string;
  /** Position in the option set, 0-based. -1 for anchors that are not options. */
  ordinal: number;
};

export type IndexableMessage = {
  id: string;
  runId: string | null;
  role: string;
  body: string[];
  createdAt: string;
};

export const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth"] as const;

export const normalizeLabel = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const MAX_SUMMARY = 240;

const tidy = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .trim()
    // A trailing conjunction belongs to the sentence, not to the option.
    .replace(/[,;]?\s+(or|and)\s*$/i, "")
    .replace(/^[\s:—–-]+/, "")
    .replace(/[\s,;.?!]+$/, "")
    .trim();

/** `(leave LiteSpeed off, I clean up the bloat)` reads better without its shell. */
const unwrap = (value: string): string => {
  let out = value.trim();
  for (let guard = 0; guard < 3; guard += 1) {
    const opened = out.startsWith("(") || out.startsWith("[");
    if (!opened) break;
    const closer = out.startsWith("(") ? ")" : "]";
    const end = out.lastIndexOf(closer);
    if (end <= 0) break;
    out = out.slice(1, end).trim();
  }
  return out;
};

type LabelHit = { label: string; letter: string; start: number; end: number };

/**
 * Two shapes count as a presented choice, and only when at least two distinct
 * labels appear in the same message:
 *   "Option A ... Option B ..."
 *   "A) ... B) ..."   (line- or sentence-initial)
 */
const findLabelHits = (text: string): LabelHit[] => {
  const explicit: LabelHit[] = [];
  for (const match of text.matchAll(/\boption\s+([A-Da-d])\b/g)) {
    const letter = match[1].toUpperCase();
    explicit.push({
      label: `Option ${letter}`,
      letter,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  if (new Set(explicit.map((hit) => hit.letter)).size >= 2) return explicit;

  const bracketed: LabelHit[] = [];
  for (const match of text.matchAll(/(?:^|\n|\.\s)\s*([A-D])\)\s+/g)) {
    const letter = match[1].toUpperCase();
    const start = (match.index ?? 0) + match[0].indexOf(letter);
    bracketed.push({ label: `Option ${letter}`, letter, start, end: start + match[0].trimEnd().length });
  }
  if (new Set(bracketed.map((hit) => hit.letter)).size >= 2) return bracketed;

  return [];
};

const aliasesFor = (label: string, letter: string, ordinal: number): string[] => {
  const word = ORDINAL_WORDS[ordinal];
  const aliases = new Set<string>([normalizeLabel(label), letter.toLowerCase()]);
  if (word) {
    aliases.add(`${word} option`);
    aliases.add(`the ${word} option`);
    aliases.add(`the ${word} one`);
    aliases.add(`${word} one`);
    aliases.add(word);
  }
  return [...aliases];
};

/**
 * Anchors present in one stored message. Only the agent (or the system on its
 * behalf) offers choices, so a user message never mints an option anchor: that
 * would let anyone author the thing the agent later treats as a reference.
 */
export const extractAnchors = (message: IndexableMessage): AnchorDraft[] => {
  if (message.role !== "agent" && message.role !== "system") return [];
  const text = message.body.join("\n").replace(/\s+/g, " ").trim();
  if (text.length === 0) return [];

  const hits = findLabelHits(text).sort((a, b) => a.start - b.start);
  if (hits.length < 2) return [];

  // The same letter can be mentioned twice ("as I said in Option A"); the first
  // occurrence is the one that introduces it.
  const seen = new Set<string>();
  const introduced: LabelHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.letter)) continue;
    seen.add(hit.letter);
    introduced.push(hit);
  }

  const drafts: AnchorDraft[] = [];
  introduced.forEach((hit, index) => {
    const nextStart = introduced[index + 1]?.start ?? text.length;
    const summary = tidy(unwrap(tidy(text.slice(hit.end, nextStart)))).slice(0, MAX_SUMMARY);
    if (summary.length < 3) return;
    drafts.push({
      anchorType: "option",
      label: hit.label,
      normalizedLabel: normalizeLabel(hit.label),
      aliases: aliasesFor(hit.label, hit.letter, index),
      summary,
      ordinal: index,
    });
  });

  if (drafts.length < 2) return [];

  drafts.unshift({
    anchorType: "option_set",
    label: drafts.map((draft) => draft.label).join(" / "),
    normalizedLabel: normalizeLabel(`option set ${drafts.map((d) => d.label).join(" ")}`),
    aliases: ["the options", "those options", "the choices"],
    summary: drafts.map((draft) => `${draft.label}: ${draft.summary}`).join(" | ").slice(0, MAX_SUMMARY * 2),
    ordinal: -1,
  });

  return drafts;
};