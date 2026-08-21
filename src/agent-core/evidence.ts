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
export const describeSeoSurface = (evidence: AgentEvidence): string[] => {
  const data = evidence.data;
  const lines: string[] = [];
  const title = str(data.title);
  const description = str(data.description);
  const canonical = str(data.canonical);
  const h1Count = num(data.h1Count);
  const sitemapCount = num(data.sitemapUrlCount);
  const internal = num(data.internalLinks);

  lines.push(
    title
      ? `The page title reads "${title}" (${num(data.titleLength) ?? title.length} characters).`
      : "The page serves no title tag.",
  );
  lines.push(
    description
      ? `Its meta description is ${num(data.descriptionLength) ?? description.length} characters long.`
      : "It serves no meta description.",
  );
  if (data.noindex === true) lines.push("It tells search engines not to index it.");
  lines.push(canonical ? `The canonical URL is ${canonical}.` : "No canonical URL is declared.");
  if (h1Count !== null) {
    lines.push(
      h1Count === 1 ? "It has a single main heading." : `It has ${h1Count} main headings.`,
    );
  }
  if (data.robotsBlocksEverything === true) lines.push("robots.txt blocks every crawler.");
  else if (data.robotsTxtPresent === false) lines.push("No robots.txt is served.");
  lines.push(
    sitemapCount !== null
      ? `The sitemap lists ${sitemapCount} URLs.`
      : "I could not read a sitemap at the usual locations.",
  );
  const schemaTypes = Array.isArray(data.schemaTypes) ? (data.schemaTypes as string[]) : [];
  lines.push(
    schemaTypes.length > 0
      ? `Structured data is present for ${schemaTypes.slice(0, 6).join(", ")}.`
      : "No structured data is present on this page.",
  );
  if (internal !== null) lines.push(`The page links to ${internal} internal pages.`);
  lines.push(
    "This is what the site serves publicly. It does not tell me how Google has actually indexed it, or how AI assistants answer questions about it.",
  );
  return lines;
};

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
    lines.push("WordPress accepted the login, but its private health API did not authorize this read, so I used the public health signals instead.");
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

// Findings for SEO + Security tools — called by findingFromEvidence below.
const findingFromPageSpeed = (evidence: AgentEvidence) => {
  const mobile = evidence.data.mobile as Record<string, unknown> | null;
  const perf = mobile ? (mobile.performanceScore as number | null) : null;
  if (perf !== null && perf < 50) {
    return {
      severity: "high" as const,
      title: "Mobile performance score is critically low",
      summary: safeSummary(`PageSpeed Insights scored mobile performance at ${perf}/100. Scores below 50 directly hurt search rankings and user experience.`),
    };
  }
  if (perf !== null && perf < 70) {
    return {
      severity: "medium" as const,
      title: "Mobile performance score needs improvement",
      summary: safeSummary(`PageSpeed Insights scored mobile performance at ${perf}/100. Google uses Core Web Vitals as a ranking signal.`),
    };
  }
  return null;
};

const findingFromSchemaValidation = (evidence: AgentEvidence) => {
  const count = num(evidence.data.blockCount) ?? 0;
  const issues = Array.isArray(evidence.data.issues) ? evidence.data.issues as string[] : [];
  if (count === 0) {
    return {
      severity: "high" as const,
      title: "No structured data found on the page",
      summary: safeSummary("The page has no JSON-LD structured data. AI platforms and search engines rely on schema markup to understand, cite, and feature businesses in AI-generated answers."),
    };
  }
  if (issues.length >= 2) {
    return {
      severity: "medium" as const,
      title: "Structured data has multiple issues",
      summary: safeSummary(`Found ${issues.length} schema issues: ${issues.slice(0, 2).join("; ")}.`),
    };
  }
  return null;
};

const findingFromSitemapAudit = (evidence: AgentEvidence) => {
  const total = num(evidence.data.totalUrls) ?? 0;
  if (total === 0) {
    return {
      severity: "high" as const,
      title: "Sitemap exists but contains no URLs",
      summary: safeSummary("The sitemap is empty. Search engines and AI crawlers use the sitemap to discover content. An empty sitemap means pages won't be found."),
    };
  }
  if (total <= 5) {
    return {
      severity: "medium" as const,
      title: "Sitemap is very thin",
      summary: safeSummary(`Only ${total} URL(s) are in the sitemap. For a site that has been through SEO optimization, this suggests pages may have been created but not added to the sitemap.`),
    };
  }
  return null;
};

const findingFromSecurityHeaders = (evidence: AgentEvidence) => {
  const grade = str(evidence.data.grade);
  const fails = num(evidence.data.fails) ?? 0;
  if (grade === "D" || fails > 0) {
    return {
      severity: "medium" as const,
      title: "Critical security headers are missing",
      summary: safeSummary(`Security header grade: ${grade ?? "?"} with ${fails} critical failure(s). Missing headers can affect site trust signals and SEO.`),
    };
  }
  return null;
};

// Patch findingFromEvidence to cover new tool ids.
const _originalFindingFromEvidence = findingFromEvidence;
/** @internal — overrides the export below with SEO tool support. */
export const findingFromEvidenceExtended = (evidence: AgentEvidence) => {
  switch (evidence.toolId) {
    case "seo.pagespeed": return findingFromPageSpeed(evidence);
    case "seo.schema_validate": return findingFromSchemaValidation(evidence);
    case "seo.sitemap_audit": return findingFromSitemapAudit(evidence);
    case "security.headers": return findingFromSecurityHeaders(evidence);
    default: return _originalFindingFromEvidence(evidence);
  }
};

// ---------------------------------------------------------------------------
// SEO + Security tool evidence summarizers
// ---------------------------------------------------------------------------

export const describePageSpeed = (evidence: AgentEvidence): string[] => {
  const lines: string[] = [];
  const mobile = evidence.data.mobile as Record<string, unknown> | null;
  const desktop = evidence.data.desktop as Record<string, unknown> | null;
  if (!mobile && !desktop) return ["PageSpeed Insights returned no data."];

  for (const [label, res] of [["Mobile", mobile], ["Desktop", desktop]] as const) {
    if (!res || res.error) { lines.push(`${label}: unavailable.`); continue; }
    const perf = res.performanceScore as number | null;
    const seoScore = res.seoScore as number | null;
    const cwv = res.cwv as Record<string, string> | null;
    lines.push(`${label} — Performance: ${perf ?? "n/a"}/100, SEO: ${seoScore ?? "n/a"}/100.`);
    if (cwv) {
      const parts = [
        cwv.lcp ? `LCP ${cwv.lcp}` : null,
        cwv.cls ? `CLS ${cwv.cls}` : null,
        cwv.fcp ? `FCP ${cwv.fcp}` : null,
        cwv.tbt ? `TBT ${cwv.tbt}` : null,
      ].filter(Boolean);
      if (parts.length) lines.push(`  Core Web Vitals: ${parts.join(", ")}.`);
    }
    const opps = res.opportunities as Array<Record<string, unknown>> | null;
    if (opps && opps.length > 0) {
      lines.push(`  Top opportunities: ${opps.map((o) => String(o.title ?? "")).filter(Boolean).join("; ")}.`);
    }
  }
  return lines;
};

export const describeSchemaValidation = (evidence: AgentEvidence): string[] => {
  const lines: string[] = [];
  const count = num(evidence.data.blockCount) ?? 0;
  const typesFound = Array.isArray(evidence.data.typesFound) ? evidence.data.typesFound as string[] : [];
  const issues = Array.isArray(evidence.data.issues) ? evidence.data.issues as string[] : [];
  const missing = Array.isArray(evidence.data.highValueMissing) ? evidence.data.highValueMissing as string[] : [];

  if (count === 0) {
    lines.push("No structured data (JSON-LD) found on the page. This is a significant AI visibility gap — search engines and AI platforms rely on schema to understand and cite the business.");
  } else {
    lines.push(`Found ${count} JSON-LD schema block(s): ${typesFound.join(", ") || "types undetected"}.`);
  }
  if (issues.length > 0) lines.push(`Schema issues: ${issues.join("; ")}.`);
  if (missing.length > 0 && missing.length <= 5) lines.push(`Missing high-value schema types: ${missing.join(", ")}.`);
  return lines;
};

export const describeSitemapAudit = (evidence: AgentEvidence): string[] => {
  const lines: string[] = [];
  const total = num(evidence.data.totalUrls) ?? 0;
  const recent = num(evidence.data.recentlyUpdated) ?? 0;
  const issues = Array.isArray(evidence.data.issues) ? evidence.data.issues as string[] : [];
  const sitemapUrl = str(evidence.data.sitemapUrl);

  lines.push(`Sitemap: ${total} URL(s) found${sitemapUrl ? ` at ${sitemapUrl}` : ""}. ${recent} updated in last 60 days.`);
  if (issues.length > 0) lines.push(`Issues: ${issues.join("; ")}.`);
  return lines;
};

export const describeSearchConsole = (evidence: AgentEvidence): string[] => {
  const lines: string[] = [];
  const indexStatus = str(evidence.data.indexStatus);
  const last90 = evidence.data.last90Days as Record<string, unknown> | null;

  if (indexStatus) lines.push(`Index status: ${indexStatus}.`);
  if (last90) {
    const clicks = num(last90.clicks) ?? 0;
    const impressions = num(last90.impressions) ?? 0;
    lines.push(`Last 90 days: ${clicks} clicks, ${impressions} impressions.`);
  }
  return lines;
};

export const describeSecurityHeaders = (evidence: AgentEvidence): string[] => {
  const lines: string[] = [];
  const grade = str(evidence.data.grade) ?? "?";
  const passes = num(evidence.data.passes) ?? 0;
  const warns = num(evidence.data.warns) ?? 0;
  const fails = num(evidence.data.fails) ?? 0;
  const checks = Array.isArray(evidence.data.checks)
    ? (evidence.data.checks as Array<Record<string, unknown>>)
    : [];

  lines.push(`Security headers: Grade ${grade} — ${passes} pass, ${warns} warn, ${fails} fail.`);
  const failedChecks = checks.filter((c) => c.grade === "fail").map((c) => String(c.note ?? c.header));
  if (failedChecks.length > 0) lines.push(`Critical missing: ${failedChecks.join("; ")}.`);
  return lines;
};
