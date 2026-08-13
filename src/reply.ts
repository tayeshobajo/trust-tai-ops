/**
 * Conversational reply composition.
 *
 * A plain message from a person deserves a real answer, not an
 * acknowledgement. Nothing here invents a finding: every line is composed from
 * project state the app already holds — stored access, the current task, and
 * what the agent is waiting on.
 */

import type { Project, Run } from "./types";
import { accessTypeLabels } from "./stacks";
import { autoAdvanceTarget, workingNarration } from "./agent";

const ACCESS_WORDS =
  /\b(access|credential|login|log in|password|sftp|ftp|ssh|wp[- ]?admin|wordpress admin|hosting|database|cpanel)\b/i;

const QUESTION_OPENERS =
  /^(do|does|did|can|could|are|is|was|will|would|have|has|should|what|why|when|which|who|how|where)\b/i;

const AFFIRMATIVE = /^(yes|yep|yeah|sure|ok|okay|correct|i do|we do|i have|we have)\b/i;

const isQuestion = (text: string) => text.trim().endsWith("?") || QUESTION_OPENERS.test(text.trim());

/** What the project genuinely holds right now, in plain English. */
const accessSummary = (project: Project) => {
  const available = project.accessMethods.filter((method) => method.status === "available");
  const stale = project.accessMethods.filter((method) => method.status === "stale");
  return {
    available: available.map((method) => accessTypeLabels[method.type] ?? method.label),
    stale: stale.map((method) => accessTypeLabels[method.type] ?? method.label),
  };
};

const list = (items: string[]) =>
  items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * The agent's reply to a plain message. Returns the lines it should say — never
 * a generic acknowledgement when something real can be said instead.
 */
export const composeReply = (project: Project, run: Run | null, message: string): string[] => {
  const text = message.trim();
  const { available, stale } = accessSummary(project);

  // Anything about access is answered from what is actually stored.
  if (ACCESS_WORDS.test(text)) {
    const lines: string[] = [];
    if (available.length > 0) {
      lines.push(`Yes — I have ${list(available)} stored for this project, sealed server-side.`);
    } else if (stale.length > 0) {
      lines.push(
        `I have ${list(stale)} on file, but it didn't verify last time I tried it, so I can't rely on it yet.`,
      );
    } else {
      lines.push("Not yet — nothing has reached me for this project, so I'm working from the public site only.");
    }

    if (isQuestion(text) || AFFIRMATIVE.test(text)) {
      if (available.length === 0) {
        lines.push(
          "WordPress Admin is usually enough to start; SFTP or SSH helps if I need to look at files or logs. Open Access & Connections, or paste the details straight into this conversation and I'll seal them without storing them in the thread.",
        );
      } else {
        lines.push("I'll keep using it for the checks that need it. Tell me if anything else should be added.");
      }
    }
    return lines;
  }

  // A question about the work itself is answered with where the task stands.
  if (run && isQuestion(text)) {
    const next = autoAdvanceTarget(project, run);
    const narration = next ? workingNarration(next) : null;
    return [
      narration ??
        "I'm holding here until I have what I need from you — I'd rather ask than guess at something I can't observe.",
    ];
  }

  if (!run) {
    return ["Tell me the site and the symptom and I'll start looking — I can begin from the public site alone."];
  }

  // Otherwise: confirm what was understood, and say what happens because of it.
  const next = autoAdvanceTarget(project, run);
  const narration = next ? workingNarration(next) : null;
  return narration
    ? ["Understood — I've taken that into account.", narration]
    : ["Understood — I've taken that into account, and it'll shape what I check next."];
};
