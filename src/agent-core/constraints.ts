/**
 * Automatic constraint memory.
 *
 * When a person says "never touch the checkout page" or "always tell me
 * before you deactivate a plugin", that is not conversation — it is a
 * standing rule that must outlive the task it was said in. An agent that
 * has to be told the same rule twice is not trustworthy, so the rule is
 * lifted out of the message and written into project memory the moment it
 * is stated.
 *
 * This is deliberately conservative. A missed constraint costs the person
 * one repetition; a hallucinated constraint silently blocks legitimate work
 * forever. So the detector only fires on unambiguous prohibitive or
 * obligating phrasing, and it never invents a rule from a mere preference
 * ("I think", "maybe", "probably").
 */

import type { MemoryEntry } from "../types";

export type DetectedConstraint = {
  /** Short, human title for the memory list. */
  title: string;
  /** The rule, in the person's own words. */
  content: string;
  importance: MemoryEntry["importance"];
  /** Stable key so the same sentence is never stored twice. */
  dedupeKey: string;
};

/** Phrasings that state a standing prohibition or obligation. */
const CONSTRAINT_PATTERNS: { pattern: RegExp; importance: MemoryEntry["importance"] }[] = [
  { pattern: /\b(never|do not ever|don't ever)\b/i, importance: "critical" },
  { pattern: /\b(do not|don't|never)\s+(touch|change|modify|edit|delete|remove|deactivate|disable|update|install|run)\b/i, importance: "critical" },
  { pattern: /\b(always)\s+(ask|check|tell|confirm|notify|back ?up|verify)\b/i, importance: "high" },
  { pattern: /\b(must not|should not|shouldn't|cannot|can't)\b/i, importance: "high" },
  { pattern: /\b(only|make sure to|be sure to|please always)\b.*\b(ask|approve|confirm|staging|backup)\b/i, importance: "high" },
  { pattern: /\b(under no circumstances|off limits|hands off|leave .* alone)\b/i, importance: "critical" },
];

/** Hedges that turn a rule back into an opinion. */
const HEDGES = /\b(i think|maybe|perhaps|probably|might|not sure|possibly|ideally)\b/i;

/** Sentences that are questions, not instructions. */
const isQuestion = (sentence: string) => sentence.trim().endsWith("?");

const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const titleFor = (sentence: string): string => {
  const clean = sentence.replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
  if (clean.length <= 68) return clean;
  return `${clean.slice(0, 65).trimEnd()}…`;
};

/** Normalised form used for dedupe, so punctuation and case do not create twins. */
const normalise = (sentence: string): string =>
  sentence.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

/**
 * Pull standing rules out of something a person said. Returns an empty array
 * for ordinary conversation, which is the overwhelmingly common case.
 */
export const detectConstraints = (text: string): DetectedConstraint[] => {
  if (!text || text.trim().length === 0) return [];

  const found: DetectedConstraint[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(text)) {
    if (isQuestion(sentence)) continue;
    if (HEDGES.test(sentence)) continue;
    // Very short fragments ("never") carry no rule worth keeping.
    if (sentence.split(/\s+/).length < 3) continue;

    const match = CONSTRAINT_PATTERNS.find((entry) => entry.pattern.test(sentence));
    if (!match) continue;

    const key = normalise(sentence);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);

    found.push({
      title: titleFor(sentence),
      content: sentence.trim(),
      importance: match.importance,
      dedupeKey: key,
    });
  }

  return found;
};

/**
 * True when this rule is already remembered for the project. Compared on the
 * normalised sentence so a re-phrase of the same words does not duplicate.
 */
export const constraintAlreadyStored = (entries: MemoryEntry[], candidate: DetectedConstraint): boolean =>
  entries.some(
    (entry) => entry.type === "constraint" && normalise(entry.content) === candidate.dedupeKey,
  );

/** Words too common to prove a rule is about a particular target. */
const STOP_WORDS = new Set([
  "never", "always", "dont", "do", "not", "the", "a", "an", "on", "in", "to", "of", "and", "or",
  "please", "make", "sure", "be", "you", "your", "my", "our", "it", "is", "are", "with", "for",
  "touch", "change", "modify", "edit", "delete", "remove", "update", "run", "install", "ask",
  "check", "tell", "confirm", "must", "should", "cannot", "cant", "shouldnt", "only", "any",
  "site", "website", "page", "file", "before", "after", "without", "me", "us", "that", "this",
]);

/**
 * Standing rules that mention the thing this action is about to change.
 *
 * Matching is intentionally blunt: a distinctive word shared between the rule
 * and the target is enough to stop and ask. False positives cost one
 * approval click; a false negative breaks something the person explicitly
 * told the agent to leave alone.
 */
export const constraintsTouching = (entries: MemoryEntry[], target: string): MemoryEntry[] => {
  const targetTokens = new Set(
    normalise(target)
      .split(" ")
      .filter((token) => token.length > 3 && !STOP_WORDS.has(token)),
  );
  if (targetTokens.size === 0) return [];

  return entries.filter((entry) => {
    if (entry.type !== "constraint") return false;
    const words = normalise(entry.content)
      .split(" ")
      .filter((token) => token.length > 3 && !STOP_WORDS.has(token));
    return words.some((token) => targetTokens.has(token));
  });
};