/**
 * Site health, read from evidence only.
 *
 * Every row here is a fact a tool actually observed. Nothing is estimated,
 * scored, or invented: when a measurement was never taken, the row says so
 * instead of guessing. This is the panel a WordPress engineer glances at —
 * is it up, is it fast, what is installed, is anything erroring, is it safe.
 */

import type { AgentEvidence } from "./agent-core/types";

export type HealthState = "good" | "warn" | "bad" | "unknown";

export type HealthMetric = {
  id: string;
  label: string;
  value: string;
  state: HealthState;
  note?: string;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Latest observation wins: a later read supersedes an earlier one. */
const latest = (evidence: AgentEvidence[], toolId: string): AgentEvidence | null => {
  const matches = evidence.filter((item) => item.toolId === toolId);
  return matches.length > 0 ? matches[matches.length - 1] : null;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export const buildSiteHealth = (evidence: AgentEvidence[]): HealthMetric[] => {
  const metrics: HealthMetric[] = [];

  const site = latest(evidence, "public_http.inspect_site");
  const surface = latest(evidence, "wordpress.inspect_public_surface");
  const health = latest(evidence, "wordpress.read_health");
  const page = latest(evidence, "browser.inspect_page_readonly");
  const plugins = latest(evidence, "wordpress.list_plugins");
  const log = latest(evidence, "wordpress.read_error_log");

  // Availability
  const status = site ? num(site.data.status) : null;
  if (status !== null) {
    metrics.push({
      id: "availability",
      label: "Availability",
      value: status >= 200 && status < 300 ? "Online" : `HTTP ${status}`,
      state: status >= 500 ? "bad" : status >= 400 ? "warn" : "good",
    });
    const ms = num(site?.data.durationMs);
    if (ms !== null) {
      metrics.push({
        id: "response",
        label: "Server response",
        value: seconds(ms),
        state: ms > 2000 ? "bad" : ms > 800 ? "warn" : "good",
      });
    }
  }

  // Real browser page speed
  const load = page ? num(page.data.loadEventMs) ?? num(page.data.domContentLoadedMs) : null;
  if (load !== null) {
    metrics.push({
      id: "pagespeed",
      label: "Page load (real browser)",
      value: seconds(load),
      state: load > 5000 ? "bad" : load > 2500 ? "warn" : "good",
    });
  }
  const bytes = page ? num(page.data.transferBytes) : null;
  const requests = page ? num(page.data.requestCount) : null;
  if (bytes !== null || requests !== null) {
    metrics.push({
      id: "weight",
      label: "Page weight",
      value: [
        bytes !== null ? `${Math.round(bytes / 1024)} KB` : null,
        requests !== null ? `${requests} requests` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      state: bytes !== null && bytes > 3_000_000 ? "warn" : "good",
    });
  }

  // Front-end errors
  const consoleErrors = page && Array.isArray(page.data.consoleErrors) ? (page.data.consoleErrors as string[]) : null;
  if (consoleErrors) {
    metrics.push({
      id: "js",
      label: "JavaScript errors",
      value: consoleErrors.length === 0 ? "None" : `${consoleErrors.length} on the homepage`,
      state: consoleErrors.length === 0 ? "good" : consoleErrors.length >= 3 ? "bad" : "warn",
    });
  }
  const failed = page && Array.isArray(page.data.failedRequests) ? page.data.failedRequests.length : null;
  if (failed !== null && failed > 0) {
    metrics.push({ id: "failed", label: "Assets failing to load", value: `${failed}`, state: "warn" });
  }

  // Plugins
  const total = plugins ? num(plugins.data.total) : null;
  if (total !== null) {
    const active = num(plugins?.data.active);
    const rows = Array.isArray(plugins?.data.plugins)
      ? (plugins?.data.plugins as Array<Record<string, unknown>>)
      : [];
    const updatable = rows.filter((row) => row.updateAvailable === true).length;
    metrics.push({
      id: "plugins",
      label: "Plugins",
      value: active !== null ? `${total} installed · ${active} active` : `${total} installed`,
      state: total > 30 ? "warn" : "good",
      note: total > 30 ? "A large plugin count is a common source of slowness and conflicts." : undefined,
    });
    if (updatable > 0) {
      metrics.push({
        id: "updates",
        label: "Pending updates",
        value: `${updatable} plugin${updatable === 1 ? "" : "s"}`,
        state: updatable > 3 ? "bad" : "warn",
      });
    }
  }

  // WordPress itself
  const generator = surface ? str(surface.data.generator) : null;
  if (generator) {
    metrics.push({ id: "core", label: "WordPress", value: generator, state: "good" });
  }

  // Security posture, only where a check genuinely reported
  if (health) {
    if (health.data.httpsEnabled === false) {
      metrics.push({ id: "https", label: "HTTPS", value: "Not enabled", state: "bad" });
    } else if (health.data.httpsEnabled === true) {
      metrics.push({ id: "https", label: "HTTPS", value: "Enabled", state: "good" });
    }
    if (health.data.usersPubliclyListed === true) {
      metrics.push({ id: "users", label: "User accounts", value: "Publicly listed", state: "warn" });
    }
    if (health.data.xmlrpcExposed === true) {
      metrics.push({ id: "xmlrpc", label: "XML-RPC", value: "Reachable", state: "warn" });
    }
  }

  // Error log
  if (log) {
    const counts = (log.data.countsBySeverity ?? {}) as Record<string, unknown>;
    const fatal = num(counts.fatal);
    const warning = num(counts.warning);
    if (fatal !== null || warning !== null) {
      metrics.push({
        id: "errors",
        label: "Recent PHP errors",
        value:
          (fatal ?? 0) > 0
            ? `${fatal} fatal`
            : (warning ?? 0) > 0
              ? `${warning} warnings`
              : "None in the recent log",
        state: (fatal ?? 0) > 0 ? "bad" : (warning ?? 0) > 0 ? "warn" : "good",
      });
    }
  }

  return metrics;
};
