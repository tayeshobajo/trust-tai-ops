/**
 * The closed set of models the reasoning layer may run on.
 *
 * A model choice changes *who thinks*, never *what the agent may do*: every
 * answer still has to survive the closed step catalog in `reasonCatalog.ts`.
 * Adding a model here is the only supported way to widen the choice — the
 * browser can name a model, but it can never define one.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

export type ReasonProvider = "anthropic" | "lovable_gateway";

export type ReasonModel = {
  /** Stable id used by the browser, settings and the audit trail. */
  id: string;
  label: string;
  provider: ReasonProvider;
  /** The id the provider itself expects. Never assembled from user input. */
  providerModel: string;
  /** Plain-English note shown in Settings. */
  note: string;
  /** Env var that must hold the credential for this provider. */
  secretName: string;
};

export const REASON_MODELS: readonly ReasonModel[] = [
  {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    provider: "anthropic",
    providerModel: "claude-sonnet-4-5",
    note: "Anthropic's balanced model. Uses your own Anthropic key and is billed to your Anthropic account.",
    secretName: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-haiku",
    label: "Claude Haiku",
    provider: "anthropic",
    providerModel: "claude-haiku-4-5",
    note: "Faster and cheaper Anthropic model. Uses the same Anthropic key.",
    secretName: "ANTHROPIC_API_KEY",
  },
  {
    id: "gemini-flash",
    label: "Gemini Flash",
    provider: "lovable_gateway",
    providerModel: "google/gemini-3.6-flash",
    note: "Fast built-in model. No extra key needed.",
    secretName: "LOVABLE_API_KEY",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    provider: "lovable_gateway",
    providerModel: "openai/gpt-5-mini",
    note: "Built-in OpenAI model. No extra key needed.",
    secretName: "LOVABLE_API_KEY",
  },
] as const;

export const DEFAULT_REASON_MODEL_ID = "claude-sonnet";

/** Resolves a requested id to a known model. Unknown input falls back, never throws. */
export const resolveReasonModel = (requested: unknown): ReasonModel => {
  const id = typeof requested === "string" ? requested.trim() : "";
  return (
    REASON_MODELS.find((model) => model.id === id) ??
    REASON_MODELS.find((model) => model.id === DEFAULT_REASON_MODEL_ID) ??
    REASON_MODELS[0]
  );
};