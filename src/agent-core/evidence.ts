/**
 * Evidence helpers.
 *
 * Findings must be grounded. Nothing in the conversation may claim something
 * that no tool actually observed, so every user-facing sentence in this file is
 * derived from a piece of AgentEvidence.
 */

import { safeSummary } from "./safety";
import type { AgentEvidence, ToolId } from "./types";

export const evidenceFor = (evidence: AgentEvidence[], toolId: ToolId): AgentEvidence | null =>
  evidence.find((item) => item.toolId === toolId) ?? null;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** Compact context for a reasoner. Structured, already redacted. */
export const toReasonerContext = (evidence: AgentEvidence[]): string[] =>
  evidence.map((item) => `${item.toolId}: ${item.summary}`);

/** What the agent may say to a person about a public site check. */
export const describeSiteInspection = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const status = num(data.status);
  const ms = num(data.durationMs);
  const finalUrl = str(data.finalUrl);
  const title = str(data.title);
  const lines: string[] = [];

  if (status === null) {
    return [safeSummary(evidence.summary)];
  }

  if (status >= 200 && status < 300) {
    lines.push(
      ms !== null
        ? `I checked the public site and it responded normally, in about ${(ms / 1000).toFixed(1)}s.`
        : "I checked the public site and it responded normally.",
    );
  } else if (status >= 300 && status < 400) {
    lines.push(`The public site is redirecting${finalUrl ? ` and lands on ${finalUrl}` : ""}.`);
  } else if (status >= 500) {
    lines.push(`The public site is returning a server error (${status}). That is a real fault, not a slow page.`);
  } else {
    lines.push(`The public site answered with ${status}.`);
  }

  if (title) lines.push(`The page it served is "${title}".`);
  return lines;
};

/** What the agent may say about the public WordPress surface. */
export const describePublicSurface = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const restAvailable = data.restApiAvailable === true;
  const name = str(data.siteName);
  const generator = str(data.generator);
  const lines: string[] = [];

  lines.push(
    restAvailable
      ? `The WordPress public interface is reachable${name ? ` for "${name}"` : ""}.`
      : "The WordPress public interface is not reachable from outside, so I can only see the page itself for now.",
  );
  if (generator) lines.push(`The site reports itself as ${generator}.`);
  return lines;
};

/** A run finding, but only when the evidence actually justifies one. */
export const describeHealth = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const lines: string[] = [];

  const readChecks = Array.isArray(data.authenticatedChecksRead) ? data.authenticatedChecksRead : [];

  if (data.authenticatedHealthAvailable === true && readChecks.length > 0) {
    // Only ever claimed for checks WordPress genuinely returned.
    lines.push(
      `I'm in. I read ${readChecks.length} of the private health checks directly, without changing anything.`,
    );
  } else if (data.authenticatedHealthCode === "unauthorized") {
    lines.push("WordPress rejected the admin access I have stored, so I could only read the public health signals.");
  } else if (data.authenticatedHealthCode === "forbidden") {
    lines.push("That WordPress account isn't allowed to read the health report, so I used the public signals instead.");
  } else if (data.credentialsRequired === true) {
    lines.push(
      "The site health report is there, but WordPress only shows it to an administrator, so I read the public health signals instead.",
    );
  } else {
    lines.push("The site health report isn't exposed here, so I read the public health signals instead.");
  }

  if (data.httpsEnabled === false) lines.push("The site is being served without HTTPS.");
  if (data.usersPubliclyListed === true) lines.push("The site publicly lists its user accounts through the API.");
  if (data.xmlrpcExposed === true) lines.push("XML-RPC is reachable from outside.");
  return lines;
};

/**
 * What a real browser observed while loading the page. Stack-neutral, and
 * strictly limited to timings and errors the page itself produced.
 */
export const describePageInspection = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const viewport = str(data.viewport) === "mobile" ? "on a phone-sized screen" : "on a desktop-sized screen";
  const load = num(data.loadEventMs) ?? num(data.domContentLoadedMs);
  const ttfb = num(data.ttfbMs);
  const lines: string[] = [];

  lines.push(
    load !== null
      ? `I loaded the page in a real browser ${viewport}. It finished loading in about ${(load / 1000).toFixed(1)}s.`
      : `I loaded the page in a real browser ${viewport}.`,
  );
  if (ttfb !== null) lines.push(`The server sent its first byte after about ${(ttfb / 1000).toFixed(1)}s.`);

  const requests = num(data.requestCount);
  const bytes = num(data.transferBytes);
  if (requests !== null && bytes !== null) {
    lines.push(`The page made ${requests} requests and transferred about ${Math.round(bytes / 1024)} KB.`);
  }

  const consoleErrors = Array.isArray(data.consoleErrors) ? (data.consoleErrors as string[]) : [];
  if (consoleErrors.length > 0) {
    lines.push(`The browser reported ${consoleErrors.length} JavaScript errors while the page loaded.`);
    lines.push(`The first one reads: ${safeSummary(consoleErrors[0], 160)}`);
  }

  const failed = Array.isArray(data.failedRequests) ? (data.failedRequests as Array<Record<string, unknown>>) : [];
  if (failed.length > 0) {
    const hosts = [...new Set(failed.map((item) => str(item.host)).filter((host): host is string => Boolean(host)))];
    lines.push(`${failed.length} requests failed to load${hosts.length > 0 ? `, from ${hosts.slice(0, 3).join(", ")}` : ""}.`);
  }
  return lines;
};

/**
 * The plugin inventory, described only as counts and names. No judgement about
 * a plugin being outdated, abandoned or vulnerable is made here: a version
 * string alone cannot prove any of those.
 */
export const describePlugins = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const total = num(data.total);
  if (total === null) return [safeSummary(evidence.summary)];

  const active = num(data.active);
  const inactive = num(data.inactive);
  const lines: string[] = [
    active !== null && inactive !== null
      ? `This install has ${total} plugins: ${active} active and ${inactive} inactive.`
      : `This install has ${total} plugins.`,
  ];

  const plugins = Array.isArray(data.plugins) ? (data.plugins as Array<Record<string, unknown>>) : [];
  const activeNames = plugins
    .filter((plugin) => plugin.status === "active")
    .map((plugin) => str(plugin.name))
    .filter((name): name is string => Boolean(name))
    .slice(0, 8);
  if (activeNames.length > 0) {
    lines.push(`The active ones include ${activeNames.join(", ")}.`);
  }

  const updatable = plugins.filter((plugin) => plugin.updateAvailable === true).length;
  if (updatable > 0) {
    // WordPress itself reported these updates; nothing is inferred.
    lines.push(`WordPress reports updates available for ${updatable} of them.`);
  }
  if (data.truncated === true) lines.push("That's the first part of the list; there are more installed.");
  return lines;
};

/**
 * The error log, described as what was read — not as a diagnosis. A component
 * named repeatedly in recent fatals is evidence pointing somewhere; it is not
 * proof of a root cause, and the wording here stays inside that limit.
 */
export const describeErrorLog = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const found = num(data.filesFound);
  if (found === null) return [safeSummary(evidence.summary)];
  if (found === 0) {
    return ["I checked the WordPress-scoped error logs I can safely read, but none are present."];
  }

  const entries = Array.isArray(data.recentEntries) ? (data.recentEntries as Array<Record<string, unknown>>) : [];
  const counts = (data.countsBySeverity ?? {}) as Record<string, unknown>;
  const fatal = num(counts.fatal) ?? 0;
  const warning = num(counts.warning) ?? 0;
  const lines: string[] = [`I read the most recent ${entries.length} entries from the WordPress error log.`];

  if (fatal > 0) {
    lines.push(`${fatal} of them are fatal PHP errors.`);
  } else if (warning > 0) {
    lines.push(`There are no fatal errors in that window, but ${warning} warnings.`);
  }

  const components = Array.isArray(data.likelyWordPressComponents)
    ? (data.likelyWordPressComponents as Array<Record<string, unknown>>)
    : [];
  const top = components[0];
  const topName = top ? str(top.name) : null;
  if (topName) {
    lines.push(`The entries most often mention the ${str(top?.kind) ?? "component"} ${topName}.`);
  }
  if (data.truncated === true) lines.push("That's only the end of the log; older entries were not read.");
  return lines;
};

export const findingFromEvidence = (
  evidence: AgentEvidence,
): { severity: "low" | "medium" | "high" | "critical"; title: string; summary: string } | null => {
  if (evidence.toolId === "browser.inspect_page_readonly") {
    const load = num(evidence.data.loadEventMs);
    const consoleErrors = Array.isArray(evidence.data.consoleErrors)
      ? (evidence.data.consoleErrors as string[])
      : [];
    if (load !== null && load > 5000) {
      return {
        severity: "medium",
        title: "Page takes a long time to finish loading",
        summary: safeSummary(
          `Loaded in a real browser, the page took about ${(load / 1000).toFixed(1)}s to finish loading.`,
        ),
      };
    }
    if (consoleErrors.length >= 3) {
      return {
        severity: "medium",
        title: "The page reports JavaScript errors in the browser",
        summary: safeSummary(
          `A real browser recorded ${consoleErrors.length} JavaScript errors while loading the page. That points at broken front-end behaviour, though it does not prove the cause.`,
        ),
      };
    }
    return null;
  }

  if (evidence.toolId === "wordpress.read_error_log") {
    const counts = (evidence.data.countsBySeverity ?? {}) as Record<string, unknown>;
    const fatal = num(counts.fatal) ?? 0;
    const components = Array.isArray(evidence.data.likelyWordPressComponents)
      ? (evidence.data.likelyWordPressComponents as Array<Record<string, unknown>>)
      : [];
    const top = components[0];
    const name = top ? str(top.name) : null;
    const mentions = top ? num(top.mentions) ?? 0 : 0;
    // Only a repeated pattern earns a finding, and it is phrased as what the
    // log says — never as a proven cause.
    if (fatal >= 2 && name && mentions >= 2) {
      return {
        severity: "high",
        title: `Recent fatal errors repeatedly reference ${name}`,
        summary: safeSummary(
          `The recent error log repeatedly references ${name} in ${fatal} fatal PHP errors. That makes it the strongest lead, though it does not prove the cause on its own.`,
        ),
      };
    }
    return null;
  }

  if (evidence.toolId === "wordpress.read_health") {
    if (evidence.data.usersPubliclyListed === true) {
      return {
        severity: "medium",
        title: "User accounts are publicly listed",
        summary: safeSummary("The WordPress API returns the site's user list to anonymous visitors."),
      };
    }
    if (evidence.data.httpsEnabled === false) {
      return {
        severity: "high",
        title: "Site is served without HTTPS",
        summary: safeSummary("The recorded site address is not using HTTPS."),
      };
    }
    return null;
  }
  const status = num(evidence.data.status);
  if (status === null) return null;
  if (status >= 500) {
    return {
      severity: "high",
      title: "Public site is returning a server error",
      summary: safeSummary(`The site answered with ${status} when checked from outside.`),
    };
  }
  const ms = num(evidence.data.durationMs);
  if (ms !== null && ms > 4000) {
    return {
      severity: "medium",
      title: "Public site is slow to respond",
      summary: safeSummary(`The first response took about ${(ms / 1000).toFixed(1)}s from outside.`),
    };
  }
  return null;
};
