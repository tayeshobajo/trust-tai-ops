/**
 * Browser-side mirror of the server's closed model list.
 *
 * This exists only so Settings can show a human choice. It carries no
 * credential and no provider endpoint: the browser sends an id, and the server
 * decides what that id actually means. `npm run check:reasoner` fails if this
 * list drifts from `supabase/functions/_shared/reasonModels.ts`.
 */

export type ReasonModelOption = {
  id: string;
  label: string;
  provider: "anthropic" | "lovable_gateway";
  note: string;
};

export const REASON_MODEL_OPTIONS: readonly ReasonModelOption[] = [
  {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    provider: "anthropic",
    note: "Anthropic's balanced model. Uses your own Anthropic key and is billed to your Anthropic account.",
  },
  {
    id: "claude-haiku",
    label: "Claude Haiku",
    provider: "anthropic",
    note: "Faster and cheaper Anthropic model. Uses the same Anthropic key.",
  },
  {
    id: "gemini-flash",
    label: "Gemini Flash",
    provider: "lovable_gateway",
    note: "Fast built-in model. No extra key needed.",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    provider: "lovable_gateway",
    note: "Built-in OpenAI model. No extra key needed.",
  },
] as const;

export const DEFAULT_REASON_MODEL_ID = "claude-sonnet";

const STORAGE_KEY = "trusttai.reasoning.model";

const known = (id: unknown): id is string =>
  typeof id === "string" && REASON_MODEL_OPTIONS.some((option) => option.id === id);

/** The operator's single global default. Unknown or unreadable storage falls back. */
export const readReasonModelId = (): string => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return known(stored) ? stored : DEFAULT_REASON_MODEL_ID;
  } catch {
    return DEFAULT_REASON_MODEL_ID;
  }
};

export const writeReasonModelId = (id: string): string => {
  const next = known(id) ? id : DEFAULT_REASON_MODEL_ID;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // A blocked storage never breaks reasoning: the server default applies.
  }
  return next;
};