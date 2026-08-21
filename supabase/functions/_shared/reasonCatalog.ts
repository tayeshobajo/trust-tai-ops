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
  | "inspect-seo-surface"
  | "inspect-page-desktop"
  | "inspect-page-mobile"
  | "inspect-page-content"
  | "inspect-wp-public"
  | "read-health"
  | "read-health-authenticated"
  | "list-plugins"
  | "wp-cli-core-version"
  | "wp-cli-core-checksums"
  | "wp-cli-core-updates"
  | "wp-cli-plugin-list"
  | "wp-cli-theme-list"
  | "wp-cli-cron-events"
  | "wp-cli-maintenance-mode"
  | "wp-cli-user-roles"
  | "wp-cli-db-size"
  | "wp-cli-debug-log-setting"
  | "read-error-log"
  | "seo-pagespeed"
  | "seo-schema-validate"
  | "seo-sitemap-audit"
  | "seo-search-console"
  | "security-headers";

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
  /** True when the planner must pass an elementQuery argument for this step. */
  elementQueryRequired?: boolean;
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
  "inspect-seo-surface": {
    id: "inspect-seo-surface",
    toolId: "public_http.inspect_seo_surface",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Read the search-visibility signals the site serves publicly: robots.txt, sitemap, title and description, canonical, indexability, structured data and internal links.",
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
  "inspect-page-content": {
    id: "inspect-page-content",
    toolId: "browser.inspect_page_readonly",
    capability: "public_internet",
    serverResolvedTarget: false,
    viewport: "desktop",
    elementQueryRequired: true,
    purpose: "Load the page in a real browser and find the page elements named in the task (buttons, links, text) — returns the actual HTML of matching elements. Use this FIRST whenever the task names specific page elements.",
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
  "wp-cli-core-updates": {
    id: "wp-cli-core-updates",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "core.check_update",
    purpose: "Check whether WordPress itself is behind on updates.",
  },
  "wp-cli-plugin-list": {
    id: "wp-cli-plugin-list",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "plugin.list",
    purpose: "Read the installed plugins and their update status directly on the server.",
  },
  "wp-cli-theme-list": {
    id: "wp-cli-theme-list",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "theme.list",
    purpose: "Read the installed themes and which one is active.",
  },
  "wp-cli-cron-events": {
    id: "wp-cli-cron-events",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "cron.event_list",
    purpose: "Read the scheduled jobs, including anything unexpected that was added.",
  },
  "wp-cli-maintenance-mode": {
    id: "wp-cli-maintenance-mode",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "maintenance_mode.status",
    purpose: "Check whether the site is stuck in maintenance mode.",
  },
  "wp-cli-user-roles": {
    id: "wp-cli-user-roles",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "user.list_roles",
    purpose: "Read the account roles defined on the site.",
  },
  "wp-cli-db-size": {
    id: "wp-cli-db-size",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "db.size",
    purpose: "Read how large the database has grown.",
  },
  "wp-cli-debug-log-setting": {
    id: "wp-cli-debug-log-setting",
    toolId: "wordpress.run_wp_cli_readonly",
    capability: "ssh",
    serverResolvedTarget: true,
    commandId: "config.get_debug_log",
    purpose: "Check whether error logging is switched on before looking for a log.",
  },
  "seo-pagespeed": {
    id: "seo-pagespeed",
    toolId: "seo.pagespeed",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Run a full PageSpeed Insights audit — Core Web Vitals, Lighthouse scores, and top performance/SEO opportunities for mobile and desktop.",
  },
  "seo-schema-validate": {
    id: "seo-schema-validate",
    toolId: "seo.schema_validate",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Extract and validate all JSON-LD structured data on the page — confirms schema types, missing required fields, and AI-visibility gaps.",
  },
  "seo-sitemap-audit": {
    id: "seo-sitemap-audit",
    toolId: "seo.sitemap_audit",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Fetch and parse the full sitemap tree — every listed URL, lastmod dates, child sitemaps, and thin or malformed sitemap flags.",
  },
  "seo-search-console": {
    id: "seo-search-console",
    toolId: "seo.search_console",
    capability: "google_search_console",
    serverResolvedTarget: false,
    purpose: "Query Google Search Console for index coverage, crawl stats, impressions, clicks, average position, CTR, and top pages. Requires a service account key stored in Access & Connections.",
  },
  "security-headers": {
    id: "security-headers",
    toolId: "security.headers",
    capability: "public_internet",
    serverResolvedTarget: false,
    purpose: "Inspect HTTP security headers — grades HSTS, CSP, X-Frame-Options, referrer policy, and permissions policy.",
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
export const REQUESTABLE_ACCESS = ["wordpress_admin", "sftp", "ssh", "hosting_portal", "google_search_console"] as const;

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
// ---------------------------------------------------------------------------
// Write step definitions (added alongside read steps above)
// These require sufficient_evidence to have been reached before they can be
// proposed by the planner. The orchestrator enforces this gate.
// ---------------------------------------------------------------------------

export type WriteStepId =
  | "fix-via-rest-api"
  | "fix-via-sftp"
  | "fix-via-wp-cli"
  | "purge-cache"
  | "toggle-wpcode"
  | "create-wpcode"
  | "activate-plugin"
  | "deactivate-plugin"
  | "flush-rewrites"
  | "enable-maintenance"
  | "disable-maintenance";

export type WriteStepSpec = {
  id: WriteStepId;
  toolId: string;
  purpose: string;
  /** Extra args to merge into the tool call when dispatching. */
  defaultArgs?: Record<string, unknown>;
  /** Human approval required before dispatch (for irreversible ops). */
  requiresConfirmation: boolean;
  /** Must be true for all write steps. Enforced by the orchestrator. */
  requiresEvidence: true;
};

export const WRITE_STEPS: Record<WriteStepId, WriteStepSpec> = {
  "fix-via-rest-api": {
    id: "fix-via-rest-api",
    toolId: "wordpress.rest_api_write",
    purpose: "Apply a fix through the WordPress REST API (events, venues, posts, taxonomies).",
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "fix-via-sftp": {
    id: "fix-via-sftp",
    toolId: "wordpress.sftp_write_file",
    purpose: "Patch a file on the server over SFTP (templates, configs, PHP snippets).",
    requiresConfirmation: true,
    requiresEvidence: true,
  },
  "fix-via-wp-cli": {
    id: "fix-via-wp-cli",
    toolId: "wordpress.run_wp_cli_write",
    purpose: "Run a write WP-CLI command (plugin activate/deactivate, option update, cron run).",
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "purge-cache": {
    id: "purge-cache",
    toolId: "wordpress.purge_cache",
    purpose: "Purge the site cache (LiteSpeed, WP-CLI object cache, WP Rocket).",
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "toggle-wpcode": {
    id: "toggle-wpcode",
    toolId: "wordpress.wpcode_snippet",
    purpose: "Activate, deactivate, or trash a WPCode code snippet.",
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "create-wpcode": {
    id: "create-wpcode",
    toolId: "wordpress.wpcode_snippet",
    purpose: "Create a new WPCode snippet (PHP or JavaScript) and activate it. This is the preferred minimal path for small code-level fixes: add a snippet, never edit theme files.",
    requiresConfirmation: true,
    requiresEvidence: true,
  },
  "activate-plugin": {
    id: "activate-plugin",
    toolId: "wordpress.run_wp_cli_write",
    purpose: "Activate a specific plugin.",
    defaultArgs: { commandId: "plugin.activate" },
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "deactivate-plugin": {
    id: "deactivate-plugin",
    toolId: "wordpress.run_wp_cli_write",
    purpose: "Deactivate a specific plugin to isolate a conflict.",
    defaultArgs: { commandId: "plugin.deactivate" },
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "flush-rewrites": {
    id: "flush-rewrites",
    toolId: "wordpress.run_wp_cli_write",
    purpose: "Flush WordPress rewrite rules to fix permalink 404s.",
    defaultArgs: { commandId: "rewrite.flush" },
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "enable-maintenance": {
    id: "enable-maintenance",
    toolId: "wordpress.run_wp_cli_write",
    purpose: "Enable maintenance mode before applying a risky change.",
    defaultArgs: { commandId: "maintenance.enable" },
    requiresConfirmation: false,
    requiresEvidence: true,
  },
  "disable-maintenance": {
    id: "disable-maintenance",
    toolId: "wordpress.run_wp_cli_write",
    purpose: "Disable maintenance mode after changes are applied.",
    defaultArgs: { commandId: "maintenance.disable" },
    requiresConfirmation: false,
    requiresEvidence: true,
  },
};
