/**
 * The agent's voice.
 *
 * The kernel decides what is true. This asks the server-side reasoner to say
 * it like a person would, streaming the words back as they are written. The
 * browser never holds a model credential and never authors a fact: it sends a
 * facts sheet built from what was actually observed, and renders what returns.
 *
 * When streaming is unavailable the caller keeps its existing composed
 * sentences, so an outage sounds terse rather than broken.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "../env";
import { getSupabaseClient } from "../supabase";
import { readReasonModelId } from "./reasonModels";
import { redactSecrets } from "./secretGuard";

export type ReplyFactsInput = {
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
  awaiting: string | null;
  recentAgentLines: string[];
  memory: string[];
};

const QUESTION_OPENERS =
  /^(do|does|did|can|could|are|is|was|will|would|have|has|should|what|why|when|which|who|how|where)\b/i;

export const looksLikeQuestion = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || QUESTION_OPENERS.test(trimmed);
};

export const voiceAvailable = (): boolean => hasSupabasePublicConfig(resolveOpsEnv());

/** Splits a written reply into the paragraph lines the thread renders. */
export const replyLines = (text: string): string[] =>
  text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);

/**
 * Streams one reply. `onText` receives the whole text so far, so the caller can
 * render it in place without reassembling deltas. Returns the finished text, or
 * an empty string when nothing usable arrived.
 */
export const streamAgentReply = async (
  projectId: string,
  facts: ReplyFactsInput,
  onText?: (soFar: string) => void,
): Promise<string> => {
  if (!voiceAvailable()) return "";
  const env = resolveOpsEnv();

  let token = env.supabasePublicKey ?? "";
  try {
    const { data } = await getSupabaseClient().auth.getSession();
    token = data.session?.access_token ?? token;
  } catch {
    // An unreadable session still authenticates as the public key; the
    // function's own project check decides what is allowed.
  }

  const payload = {
    projectId,
    mode: "compose_reply",
    model: readReasonModelId(),
    facts: {
      ...facts,
      // Persisted text is already sanitized; redacting again means nothing
      // credential-shaped can leave the browser even if one ever slipped in.
      question: redactSecrets(facts.question),
      observations: facts.observations.map(redactSecrets),
      kernelLines: facts.kernelLines.map(redactSecrets),
      recentAgentLines: facts.recentAgentLines.map(redactSecrets),
      memory: facts.memory.map(redactSecrets),
      awaiting: facts.awaiting ?? "",
    },
  };

  let response: Response;
  try {
    response = await fetch(`${env.supabaseUrl}/functions/v1/agent-reason`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.supabasePublicKey ?? "",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return "";
  }

  if (!response.ok || !response.body) return "";
  // A refusal comes back as ordinary JSON, never as a stream.
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const raw of parts) {
        const trimmed = raw.trim();
        if (!trimmed.startsWith("data:")) continue;
        const body = trimmed.slice(5).trim();
        if (!body || body === "[DONE]") continue;
        try {
          const event = JSON.parse(body) as { text?: unknown };
          if (typeof event.text === "string") {
            text += event.text;
            onText?.(text);
          }
        } catch {
          // Skip a malformed frame rather than losing the rest of the reply.
        }
      }
    }
  } catch {
    // A cut stream keeps whatever was already said.
  }

  return text.trim();
};
