import type { MessageKind, ProjectMessage, Run } from "./types";
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
export const dedupeKeyForThreadMessage = (message: ThreadMessage, _run: Run): string =>
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
