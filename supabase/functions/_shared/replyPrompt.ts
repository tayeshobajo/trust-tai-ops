/**
 * Voice layer.
 *
 * The kernel decides what is true; this decides how it is said. A model is
 * given a facts sheet built server-side from what the run actually observed,
 * and it may write nothing that is not on that sheet.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import { redact } from "./net.ts";

const scrubCredentialPhrases = (value: string): string =>
  value.replace(
    /\b(password|passwd|pass|api[\s_-]?key|secret|token|passphrase)\b\s*(?:is|=|:)?\s*\S+/gi,
    "$1 [redacted]",
  );

const line = (value: unknown, max = 400): string =>
  typeof value === "string" ? redact(scrubCredentialPhrases(value.replace(/\s+/g, " ").trim())).slice(0, max) : "";

const lines = (value: unknown, limit: number, max = 400): string[] =>
  Array.isArray(value) ? value.map((item) => line(item, max)).filter(Boolean).slice(-limit) : [];

export type ReplyFacts = {
  stack: string;
  taskTitle: string;
  taskType: string;
  siteKnown: boolean;
  question: string;
  isQuestion: boolean;
  storedAccess: string[];
  verifiedAccess: string[];
  observations: string[];
  kernelLines: string[];
  awaiting: string;
  recentAgentLines: string[];
  memory: string[];
};

const ACCESS_WORDS = [
  "public_internet",
  "wordpress_admin",
  "sftp",
  "ssh",
  "hosting_portal",
  "database",
  "cdn",
];

const access = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && ACCESS_WORDS.includes(item)).slice(0, 8)
    : [];

const AWAITING = ["access", "backup", "approval", ""];

/** Normalizes and bounds whatever the browser sent. Never throws. */
export const sanitizeReplyFacts = (value: unknown): ReplyFacts => {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const awaitingClaim = line(raw.awaiting, 20);
  return {
    stack: line(raw.stack, 24) || "wordpress",
    taskTitle: line(raw.taskTitle, 160),
    taskType: line(raw.taskType, 40) || "unknown",
    siteKnown: raw.siteKnown === true,
    question: line(raw.question, 600),
    isQuestion: raw.isQuestion === true,
    storedAccess: access(raw.storedAccess),
    verifiedAccess: access(raw.verifiedAccess),
    observations: lines(raw.observations, 14),
    kernelLines: lines(raw.kernelLines, 14),
    awaiting: AWAITING.includes(awaitingClaim) ? awaitingClaim : "",
    recentAgentLines: lines(raw.recentAgentLines, 8, 240),
    memory: lines(raw.memory, 6, 320),
  };
};

export const REPLY_SYSTEM_PROMPT = [
  "You are the voice of an engineering operations agent. You talk to the site owner in a chat window.",
  "You sound like a calm, senior engineer who is genuinely working on their site: warm, direct, unhurried, never corporate.",
  "",
  "Absolute rules:",
  "- You may only state things that appear in the FACTS below. If a fact is not there, you do not know it. Never invent a finding, a cause, a fix, a number, or a timeline.",
  "- Access that is stored is NOT access that works. Only say you can get in when it appears under access proven working.",
  "- Never mention tools, tool ids, internal states, run ids, JSON, or credentials. Never quote a password even if one appears.",
  "- Never restate a sentence listed under 'you already said'. Say the new thing, or say nothing extra.",
  "",
  "How to write:",
  "- If the person asked a question, answer it in the very first sentence. Yes, no, or the honest 'not yet, because…'.",
  "- Then, at most a couple of short sentences: what you found, what you're doing, or what you need from them.",
  "- Plain prose. No headings, no bullet lists, no markdown, no emoji, no sign-off.",
  "- Under 80 words unless there is genuinely more to report. Contractions are good. One idea per sentence.",
  "- If you need something from them, ask for exactly one thing, and say why it unlocks the next step.",
  "- Only ask for more access as a last resort. If you do, first say in one clause what you already tried and what specifically you still cannot see. Never ask for access you have not exhausted the alternatives to.",
  "- Never present a blocked route as a dead end while other routes are still open. Say what you're trying next instead.",
  "- When the brief asks for several things and some of them need systems you cannot reach (Search Console, analytics or SEO suites, paid tools, testing prompts inside another AI product, anything behind a login you were not given), say plainly and early which parts you can check yourself and which parts you cannot do at all. Never let an unaddressed part of the brief pass in silence, and never imply you covered it.",
  "- Do not declare a site healthy, fine, or resolved on indirect signals. Name what you actually observed, and name what you did not check.",
  "- If nothing new is known, say so plainly rather than padding.",

  "",
  "Write only the reply text. No preamble, no quotes around it.",
].join("\n");

const labels: Record<string, string> = {
  public_internet: "the public site",
  wordpress_admin: "WordPress Admin",
  sftp: "SFTP/FTP",
  ssh: "SSH",
  hosting_portal: "the hosting portal",
  database: "the database",
  cdn: "the CDN",
};

const label = (value: string) => labels[value] ?? value;

export const replyUserPrompt = (facts: ReplyFacts): string =>
  [
    "FACTS (everything you are allowed to say comes from here):",
    `- This project runs on ${facts.stack}.`,
    facts.taskTitle ? `- What they asked for: ${facts.taskTitle}` : "",
    `- Site address known: ${facts.siteKnown ? "yes" : "no"}`,
    `- Access stored but not proven: ${
      facts.storedAccess.filter((item) => !facts.verifiedAccess.includes(item)).map(label).join(", ") || "none"
    }`,
    `- Access proven working: ${facts.verifiedAccess.map(label).join(", ") || "none"}`,
    facts.awaiting ? `- You are currently waiting on the person for: ${facts.awaiting}` : "",
    ...(facts.observations.length > 0
      ? ["- Observed on the real site:", ...facts.observations.map((item) => `  · ${item}`)]
      : ["- Observed on the real site: nothing yet this turn."]),
    ...(facts.kernelLines.length > 0
      ? ["- What your own checks just concluded (true, but written robotically — say it in your own words):",
         ...facts.kernelLines.map((item) => `  · ${item}`)]
      : []),
    ...(facts.memory.length > 0 ? ["- Known about this project:", ...facts.memory.map((item) => `  · ${item}`)] : []),
    ...(facts.recentAgentLines.length > 0
      ? ["- You already said this recently, do not repeat it:", ...facts.recentAgentLines.map((item) => `  · ${item}`)]
      : []),
    "",
    facts.question
      ? `The person just ${facts.isQuestion ? "asked" : "said"}: "${facts.question}"`
      : "The person is waiting to hear from you.",
    "",
    facts.isQuestion
      ? "Answer their question directly in the first sentence, then continue."
      : "Reply to what they said, then say what happens next.",
  ]
    .filter((part) => part !== "")
    .join("\n");
