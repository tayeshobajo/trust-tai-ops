/**
 * Closed reasoning catalog.
 *
 * A model may choose *which* known inspection happens next and how it is
 * explained in plain English. It may never invent a tool, an argument, a
 * command, a URL, or a capability. Everything a model returns is validated
 * against this catalog before it leaves the server, and the browser rebuilds
 * the real action from the catalog id alone.
 *
 * Pure TypeScript on purpose: no Deno globals, no npm specifiers, so the same
 * code that runs in production is exercised by the checks.
 */

export type ReasonStepId =
  | "inspect-site"
  | "inspect-page-desktop"
  | "inspect-page-mobile"
  | "inspect-wp-public"
  | "read-health"
  | "read-health-authenticated"
  | "list-plugins"
  | "wp-cli-core-version"
  | "wp-cli-core-checksums"
  | "read-error-log";

export type ReasonStepSpec = {
  id: ReasonStepId;
  toolId: string;
  /** Capability that must already be present before this step may be chosen. */
  capability: string;
  /** True when the tool resolves its own target server-side. */
  serverResolvedTarget: boolean;
  /** Fixed catalog command, for WP-CLI steps only. */
  commandId?: string;
  /** Fixed viewport, for browser steps only. */
  viewport?: "desktop" | "mobile";
  purpose: string;
};

export const REASON_STEPS: Record<ReasonStepId, ReasonStepSpec> = {
  "inspect-site": {
    id: "inspect-site",
    toolId: "public_http.inspect_site",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "See how the public site responds from outside.",
  },
  "inspect-page-desktop": {
    id: "inspect-page-desktop",
    toolId: "browser.inspect_page_readonly",
    capability: "public_internet",
    serverResolvedTarget: false,
    viewport: "desktop",
    purpose: "Load the page in a real browser on a desktop screen and watch how it performs.",
  },
  "inspect-page-mobile": {
    id: "inspect-page-mobile",
    toolId: "browser.inspect_page_readonly",
    capability: "public_internet",
    serverResolvedTarget: false,
    viewport: "mobile",
    purpose: "Load the page in a real browser on a phone-sized screen and watch how it performs.",
  },
  "inspect-wp-public": {
    id: "inspect-wp-public",
    toolId: "wordpress.inspect_public_surface",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Read the publicly visible WordPress signals.",
  },
  "read-health": {
    id: "read-health",
    toolId: "wordpress.read_health",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Read the site's health signals.",
  },
  "read-health-authenticated": {
    id: "read-health-authenticated",
    toolId: "wordpress.read_health",
    capability: "wordpress_admin",
    serverResolvedTarget: false,
    purpose: "Read the private health checks using the stored WordPress admin access.",
  },
  "list-plugins": {
    id: "list-plugins",
    toolId: "wordpress.list_plugins",
    capability: "wordpress_admin",
    serverResolvedTarget: true,
    purpose: "Read the installed plugins without changing anything.",
  },
  "wp-cli-core-version": {
    id: "wp-cli-core-version",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "core.version",
    purpose: "Read the WordPress version directly on the server.",
  },
  "wp-cli-core-checksums": {
    id: "wp-cli-core-checksums",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "core.verify_checksums",
    purpose: "Compare the core files against the official checksums.",
  },
  "read-error-log": {
    id: "read-error-log",
    toolId: "wordpress.read_error_log",
    capability: "ssh",
    serverResolvedTarget: true,
    purpose: "Read the recent WordPress error log entries, without changing anything.",
  },
};

export const REASON_STEP_IDS = Object.keys(REASON_STEPS) as ReasonStepId[];

export const REASON_INTENTS = [
  "inspect_public_surface",
  "request_access",
  "report_findings",
  "await_human_decision",
  "no_action",
] as const;

export type ReasonIntent = (typeof REASON_INTENTS)[number];

/** Access the agent is allowed to ask a human for. Nothing else is offered. */
export const REQUESTABLE_ACCESS = ["wordpress_admin", "sftp", "ssh", "hosting_portal"] as const;

/** The maximum number of inspections one turn may plan. */
export const MAX_STEPS_PER_TURN = 4;

export type ReasonPlan = {
  intent: ReasonIntent;
  rationale: string;
  message: string[];
  requestedAccess: string[];
  steps: Array<{ id: ReasonStepId; purpose: string }>;
  expectedOutcome: string;
  qaPlan: string[];
};

const MAX_LINE = 400;

const cleanLine = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINE);
};

const cleanLines = (value: unknown, limit: number): string[] =>
  Array.isArray(value)
    ? value.map(cleanLine).filter((line) => line.length > 0).slice(0, limit)
    : [];

export type ReasonValidation =
  | { ok: true; plan: ReasonPlan }
  | { ok: false; reason: string };

/**
 * Validates a model answer into a plan the system is willing to act on.
 * Anything unknown, unsupported, or beyond the caller's real capabilities is
 * dropped rather than corrected — the deterministic operator then takes over.
 */
export const validateReasonPlan = (
  value: unknown,
  capabilities: string[],
): ReasonValidation => {
  if (!value || typeof value !== "object") return { ok: false, reason: "not an object" };
  const raw = value as Record<string, unknown>;

  const intent = raw.intent as ReasonIntent;
  if (!REASON_INTENTS.includes(intent)) return { ok: false, reason: "unknown intent" };

  const rationale = cleanLine(raw.rationale);
  if (!rationale) return { ok: false, reason: "missing rationale" };

  const seen = new Set<string>();
  const steps: ReasonPlan["steps"] = [];
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  for (const entry of rawSteps) {
    const id = (entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : entry) as string;
    const spec = REASON_STEPS[id as ReasonStepId];
    if (!spec) return { ok: false, reason: `unknown step: ${String(id).slice(0, 40)}` };
    if (seen.has(spec.id)) continue;
    if (!capabilities.includes(spec.capability)) {
      return { ok: false, reason: `step beyond available access: ${spec.id}` };
    }
    seen.add(spec.id);
    const purpose =
      cleanLine(entry && typeof entry === "object" ? (entry as Record<string, unknown>).purpose : "") ||
      spec.purpose;
    steps.push({ id: spec.id, purpose });
    if (steps.length >= MAX_STEPS_PER_TURN) break;
  }

  const requestedAccess = (Array.isArray(raw.requestedAccess) ? raw.requestedAccess : [])
    .filter((item): item is string => typeof item === "string")
    .filter((item) => (REQUESTABLE_ACCESS as readonly string[]).includes(item))
    .filter((item) => !capabilities.includes(item))
    .slice(0, 2);

  if (intent === "request_access" && steps.length > 0) {
    return { ok: false, reason: "cannot both act and wait for access" };
  }

  return {
    ok: true,
    plan: {
      intent,
      rationale,
      message: cleanLines(raw.message, 4),
      requestedAccess,
      steps,
      expectedOutcome: cleanLine(raw.expectedOutcome) || rationale,
      qaPlan: cleanLines(raw.qaPlan, 4),
    },
  };
};