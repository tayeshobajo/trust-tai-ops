import type { MessageKind, ProjectMessage } from "./types";
import type { ThreadMessage } from "./conversation";

// Thread elements whose wording legitimately changes as the task moves on.
// Their persisted record is keyed per state so history stays truthful
// without a single line being rewritten after the fact.
const VOLATILE_SUFFIXES = ["-working", "-qa", "-qa-working", "-plan-working"];

const isVolatile = (id: string) => VOLATILE_SUFFIXES.some((suffix) => id.endsWith(suffix));

// Stable, order-independent signature of what a message actually says.
const bodySignature = (body: string[]): string => {
  const text = body.join("\n").trim();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

// Volatile lines are keyed by their wording, not by run state, so the same
// sentence is never written twice while genuinely new wording still lands.
export const dedupeKeyForThreadMessage = (message: ThreadMessage): string =>
  isVolatile(message.id) ? `${message.id}:${bodySignature(message.body)}` : message.id;

export const contentSignature = (role: string, body: string[]): string =>
  `${role}:${bodySignature(body)}`;

export const kindForThreadMessage = (message: ThreadMessage): MessageKind => {
  if (message.decision) return "decision_request";
  if (isVolatile(message.id)) return "status_update";
  return "message";
};

// The user brief is persisted as a real user message when the task starts,
// so it must never be re-emitted from the reconstructed thread.
export const shouldPersistThreadMessage = (message: ThreadMessage): boolean =>
  message.role === "agent" && message.body.some((line) => line.trim().length > 0);

const startOfDay = (value: string) => {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

export const dayLabel = (value: string): string => {
  const today = startOfDay(new Date().toISOString());
  const day = startOfDay(value);
  const oneDay = 24 * 60 * 60 * 1000;

  if (day === today) return "Today";
  if (day === today - oneDay) return "Yesterday";

  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const timeLabel = (value: string): string =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const sortMessages = (messages: ProjectMessage[]): ProjectMessage[] =>
  [...messages].sort((a, b) => {
    const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

export const countMessagesForRun = (messages: ProjectMessage[], runId: string): number =>
  messages.filter((message) => message.runId === runId).length;

// ---------------------------------------------------------------------------
// Conversation search
// ---------------------------------------------------------------------------

const normalize = (value: string) => value.toLowerCase();

export const matchesQuery = (body: string[], query: string): boolean => {
  const needle = normalize(query.trim());
  if (!needle) return true;
  return normalize(body.join("\n")).includes(needle);
};

export type SearchHit = {
  runId: string | null;
  excerpt: string;
  role: ProjectMessage["role"];
  createdAt: string;
};

/** Excerpt around the first match, so a hit reads like the sentence it came from. */
export const excerptFor = (body: string[], query: string, radius = 70): string => {
  const text = body.join(" ").replace(/\s+/g, " ").trim();
  const index = normalize(text).indexOf(normalize(query.trim()));
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.trim().length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

/** Matches in other tasks of the same project, newest first. */
export const findHitsOutsideRun = (
  messages: ProjectMessage[],
  activeRunId: string | null,
  query: string,
  limit = 6,
): SearchHit[] => {
  if (!query.trim()) return [];
  return sortMessages(messages)
    .reverse()
    .filter((message) => message.runId !== activeRunId && matchesQuery(message.body, query))
    .slice(0, limit)
    .map((message) => ({
      runId: message.runId,
      excerpt: excerptFor(message.body, query),
      role: message.role,
      createdAt: message.createdAt,
    }));
};

/** Splits text into plain and matching segments so a hit can be highlighted. */
export type HighlightSegment = { text: string; match: boolean };

export const highlightSegments = (text: string, query: string): HighlightSegment[] => {
  const needle = normalize(query.trim());
  if (!needle) return [{ text, match: false }];
  const haystack = normalize(text);
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let index = haystack.indexOf(needle, cursor);
  while (index >= 0) {
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
    index = haystack.indexOf(needle, cursor);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
};
