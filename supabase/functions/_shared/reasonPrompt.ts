/**
 * Prompt construction for the server-side reasoner.
 *
 * The browser sends a digest of what it already knows. That digest is treated
 * as untrusted text: it is redacted and bounded here before a model ever sees
 * it, and it never carries a credential, a header, or a raw provider error.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import { redact } from "./net.ts";
import { MAX_STEPS_PER_TURN, REASON_STEPS, REASON_STEP_IDS, REQUESTABLE_ACCESS } from "./reasonCatalog.ts";

export type ReasonDigest = {
  taskType: string;
  taskTitle: string;
  siteKnown: boolean;
  capabilities: string[];
  verifiedCapabilities: string[];
  evidence: Array<{ toolId: string; summary: string }>;
  messages: Array<{ role: string; text: string }>;
  memory: string[];
};

/**
 * People paste credentials into chat. Anything that looks like "the password
 * is X" loses its value here, before a model or a log ever sees it.
 */
const scrubCredentialPhrases = (value: string): string =>
  value.replace(
    /\b(password|passwd|pass|api[\s_-]?key|secret|token|passphrase)\b\s*(?:is|=|:)?\s*\S+/gi,
    "$1 [redacted]",
  );

const line = (value: unknown, max = 300): string =>
  typeof value === "string" ? redact(scrubCredentialPhrases(value.replace(/\s+/g, " ").trim())).slice(0, max) : "";

const list = (value: unknown, allowed?: readonly string[]): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .filter((item) => !allowed || allowed.includes(item))
        .slice(0, 12)
    : [];

const KNOWN_CAPABILITIES = [
  "public_internet",
  "wordpress_admin",
  "sftp",
  "ssh",
  "hosting_portal",
  "database",
  "cdn",
] as const;

/** Normalizes and bounds whatever the browser sent. Never throws. */
export const sanitizeDigest = (value: unknown): ReasonDigest => {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const messages = Array.isArray(raw.messages) ? raw.messages : [];

  return {
    taskType: line(raw.taskType, 40) || "unknown",
    taskTitle: line(raw.taskTitle, 160),
    siteKnown: raw.siteKnown === true,
    capabilities: list(raw.capabilities, KNOWN_CAPABILITIES),
    verifiedCapabilities: list(raw.verifiedCapabilities, KNOWN_CAPABILITIES),
    evidence: evidence
      .slice(-12)
      .map((item) => {
        const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return { toolId: line(entry.toolId, 60), summary: line(entry.summary, 300) };
      })
      .filter((item) => item.toolId.length > 0),
    messages: messages
      .slice(-12)
      .map((item) => {
        const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const role = line(entry.role, 12);
        return { role: role === "agent" ? "agent" : "human", text: line(entry.text, 400) };
      })
      .filter((item) => item.text.length > 0),
    memory: (Array.isArray(raw.memory) ? raw.memory : []).slice(-8).map((item) => line(item, 200)).filter(Boolean),
  };
};

export const SYSTEM_PROMPT = [
  "You are the reasoning layer of a WordPress operations agent used by a calm senior engineer.",
  "You decide only what should happen NEXT in one turn. You never execute anything yourself.",
  "",
  "Hard rules:",
  "- You may only choose steps from the provided catalog, by their exact id.",
  "- Never invent a tool, a command, an argument, a URL, or an access type.",
  `- Never choose a step whose required access is not already available.`,
  `- At most ${MAX_STEPS_PER_TURN} steps per turn, and never repeat a step already done.`,
  "- If nothing further can be observed with current access, either request the single most useful access, or report findings.",
  "- If you set intent to request_access, plan zero steps.",
  "- Everything you write is shown to a non-technical person: plain English, no internal state names, no jargon, no credentials.",
  "- Never claim anything that the evidence does not actually show. Unknown is a valid answer.",
  "",
  "Answer with JSON only, matching this shape:",
  '{"intent":"...","rationale":"...","message":["..."],"requestedAccess":["..."],"steps":[{"id":"...","purpose":"..."}],"expectedOutcome":"...","qaPlan":["..."]}',
  "",
  `Valid intents: inspect_public_surface, request_access, report_findings, await_human_decision, no_action.`,
  `Valid requestedAccess values: ${REQUESTABLE_ACCESS.join(", ")}.`,
].join("\n");

export const catalogPrompt = (capabilities: string[]): string =>
  [
    "Step catalog:",
    ...REASON_STEP_IDS.map((id) => {
      const spec = REASON_STEPS[id];
      const usable = capabilities.includes(spec.capability);
      return `- ${spec.id} — ${spec.purpose} (needs: ${spec.capability}; ${usable ? "AVAILABLE" : "NOT AVAILABLE"})`;
    }),
  ].join("\n");

export const userPrompt = (digest: ReasonDigest): string => {
  const done = digest.evidence.map((item) => item.toolId);
  return [
    `Task type: ${digest.taskType}`,
    digest.taskTitle ? `What the person asked: ${digest.taskTitle}` : "",
    `Site address known: ${digest.siteKnown ? "yes" : "no"}`,
    `Access available: ${digest.capabilities.join(", ") || "none"}`,
    `Access proven working: ${digest.verifiedCapabilities.join(", ") || "none"}`,
    "",
    catalogPrompt(digest.capabilities),
    "",
    `Already observed this run: ${done.length > 0 ? [...new Set(done)].join(", ") : "nothing yet"}`,
    ...(digest.evidence.length > 0
      ? ["Findings so far:", ...digest.evidence.map((item) => `- ${item.toolId}: ${item.summary}`)]
      : []),
    ...(digest.memory.length > 0 ? ["What we already know about this project:", ...digest.memory.map((m) => `- ${m}`)] : []),
    ...(digest.messages.length > 0
      ? ["Recent conversation:", ...digest.messages.map((m) => `${m.role}: ${m.text}`)]
      : []),
    "",
    "Decide the next turn.",
  ]
    .filter((part) => part !== "")
    .join("\n");
};

/** Extracts the first JSON object from a model answer. Never throws. */
export const parseModelJson = (content: string): unknown => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
};