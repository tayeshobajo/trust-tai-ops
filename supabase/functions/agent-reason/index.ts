// Trust Tai Ops — server-side reasoning boundary.
//
// The browser never talks to a model and never holds a model credential. It
// sends a redacted digest of what it already knows; this function proves the
// caller belongs to the project, asks a model what should happen next, and
// returns only a plan drawn from a closed catalog of read-only inspections.
//
// Nothing here executes a tool, and nothing here can mutate WordPress.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured } from "../_shared/clients.ts";
import { validateReasonPlan } from "../_shared/reasonCatalog.ts";
import { resolveReasonModel, type ReasonModel } from "../_shared/reasonModels.ts";
import { SYSTEM_PROMPT, parseModelJson, sanitizeDigest, userPrompt } from "../_shared/reasonPrompt.ts";
import type { ReasonDigest } from "../_shared/reasonPrompt.ts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 1200;

const fail = (code: string, summary: string, retryable: boolean, status = 200) =>
  Response.json({ ok: false, code, summary, retryable }, { status, headers: corsHeaders });

type ProviderCall = { url: string; headers: Record<string, string>; body: unknown };

/**
 * Each provider gets the same system prompt and the same sanitized digest. The
 * only thing that varies is the wire format — never what the model is allowed
 * to answer with.
 */
const buildCall = (model: ReasonModel, apiKey: string, digest: ReasonDigest): ProviderCall => {
  if (model.provider === "anthropic") {
    return {
      url: ANTHROPIC,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: {
        model: model.providerModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(digest) }],
      },
    };
  }

  return {
    url: GATEWAY,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: {
      model: model.providerModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(digest) },
      ],
      response_format: { type: "json_object" },
    },
  };
};

/** Pulls the answer text out of either provider's envelope. Never throws. */
export const readModelText = (provider: ReasonModel["provider"], payload: unknown): string => {
  const root = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (provider === "anthropic") {
    const blocks = Array.isArray(root.content) ? root.content : [];
    return blocks
      .map((block) => {
        const entry = (block && typeof block === "object" ? block : {}) as Record<string, unknown>;
        return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
      })
      .join("")
      .trim();
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = (choices[0] && typeof choices[0] === "object" ? choices[0] : {}) as Record<string, unknown>;
  const message = (first.message && typeof first.message === "object" ? first.message : {}) as Record<string, unknown>;
  return typeof message.content === "string" ? message.content : "";
};

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you to be signed in before I can think about this project.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("invalid_input", "Unsupported request.", false);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_input", "I couldn't read that request.", false);
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return fail("invalid_input", "No project was named.", false);

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) {
    return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before doing anything.", false);
  }

  const model = resolveReasonModel(body.model);
  const apiKey = Deno.env.get(model.secretName);
  if (!apiKey) {
    return fail(
      "reasoner_unavailable",
      model.provider === "anthropic"
        ? "My reasoning service needs an Anthropic key before I can use Claude."
        : "My reasoning service isn't configured yet.",
      false,
    );
  }

  const digest = sanitizeDigest(body.digest);
  const call = buildCall(model, apiKey, digest);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(call.url, {
      method: "POST",
      signal: controller.signal,
      headers: call.headers,
      body: JSON.stringify(call.body),
    });
  } catch {
    return fail("reasoner_unavailable", "I couldn't reach my reasoning service just now.", true);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return fail("rate_limited", "I'm being rate limited right now — I'll fall back to my standard checks.", true);
  }
  if (response.status === 401 || response.status === 403) {
    return fail(
      "reasoner_unauthorized",
      model.provider === "anthropic"
        ? "My Anthropic key was rejected, so I'm using my standard checks."
        : "My reasoning service rejected its own credential.",
      false,
    );
  }
  if (response.status === 402) {
    return fail("payment_required", "My reasoning service needs credits topped up.", false);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`agent-reason ${model.provider} failed [${response.status}]: ${detail.slice(0, 500)}`);
    return fail("reasoner_unavailable", "My reasoning service returned an error.", true);
  }

  let content = "";
  try {
    content = readModelText(model.provider, await response.json());
  } catch {
    content = "";
  }

  const validated = validateReasonPlan(parseModelJson(content), digest.capabilities);
  if (!validated.ok) {
    console.error(`agent-reason rejected model plan: ${validated.reason}`);
    return fail("plan_rejected", "I couldn't form a safe next step, so I'm using my standard checks.", false);
  }

  return Response.json({ ok: true, model: model.id, plan: validated.plan }, { headers: corsHeaders });
});