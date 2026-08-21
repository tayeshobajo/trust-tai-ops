/**
 * SEO + Security tool implementations for the agent-execute edge function.
 *
 * All tools are read-only, use only public/free APIs, and never accept
 * caller-supplied credentials. Any API key is resolved from Deno.env.
 *
 * Tools:
 *  - runPageSpeed       — PageSpeed Insights (Google API, free)
 *  - runSchemaValidate  — JSON-LD extraction + validation (no external API)
 *  - runSitemapAudit    — Direct sitemap fetch + XML parse (no API)
 *  - runSearchConsole   — Google Search Console Data API (OAuth via stored credential)
 *  - runSecurityHeaders — Direct HTTP header inspection (no API)
 */

import { validatePublicUrl } from "./net.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type FailResult = { ok: false; code: string; summary: string; retryable: boolean };
type OkResult   = { ok: true;  summary: string; data: Record<string, unknown> };

const fail = (code: string, summary: string, retryable = false): FailResult =>
  ({ ok: false, code, summary, retryable });

const ok = (summary: string, data: Record<string, unknown>): OkResult =>
  ({ ok: true, summary, data });

/** Resolve a URL string, validate it, return a URL or a FailResult. */
const safeUrl = (raw: string): { url: URL } | FailResult => {
  const v = validatePublicUrl(raw);
  if (!v.ok) return fail("invalid_url", v.reason, false);
  return { url: v.url };
};

/** Timed fetch with AbortController. Returns Response or null on timeout/error. */
const timedFetch = async (
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<Response | null> => {
  const { timeoutMs = 12_000, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// 1. PageSpeed Insights
// ---------------------------------------------------------------------------

export const runPageSpeed = async (rawUrl: string): Promise<OkResult | FailResult> => {
  const resolved = safeUrl(rawUrl);
  if (!("url" in resolved)) return resolved;
  const url = resolved.url.toString();

  const apiKey = Deno.env.get("GOOGLE_PSI_API_KEY") ?? "";
  const results: Record<string, unknown> = {};

  for (const strategy of ["mobile", "desktop"] as const) {
    const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("strategy", strategy);
    // Multiple category params — append manually
    endpoint.searchParams.append("category", "performance");
    endpoint.searchParams.append("category", "seo");
    if (apiKey) endpoint.searchParams.set("key", apiKey);

    const res = await timedFetch(endpoint.toString(), { timeoutMs: 30_000 });
    if (!res || !res.ok) {
      results[strategy] = { error: res ? `HTTP ${res.status}` : "timeout" };
      continue;
    }

    let json: Record<string, unknown>;
    try { json = await res.json() as Record<string, unknown>; }
    catch { results[strategy] = { error: "Unparseable response." }; continue; }

    const lhr = json.lighthouseResult as Record<string, unknown> ?? {};
    const cats = (lhr.categories as Record<string, unknown>) ?? {};
    const audits = (lhr.audits as Record<string, unknown>) ?? {};

    const getDisplay = (id: string) =>
      String(((audits[id] as Record<string, unknown>)?.displayValue) ?? "");

    const scoreOf = (cat: string) => {
      const v = (cats[cat] as Record<string, unknown>)?.score;
      return typeof v === "number" ? Math.round(v * 100) : null;
    };

    const opps = Object.values(audits)
      .filter((a) => {
        const audit = a as Record<string, unknown>;
        return typeof audit.score === "number" && audit.score < 0.9 &&
          (audit.details as Record<string, unknown> | undefined)?.type === "opportunity";
      })
      .slice(0, 5)
      .map((a) => {
        const audit = a as Record<string, unknown>;
        return { id: audit.id, title: audit.title, savings: audit.displayValue };
      });

    results[strategy] = {
      performanceScore: scoreOf("performance"),
      seoScore: scoreOf("seo"),
      cwv: {
        lcp: getDisplay("largest-contentful-paint"),
        cls: getDisplay("cumulative-layout-shift"),
        fcp: getDisplay("first-contentful-paint"),
        tbt: getDisplay("total-blocking-time"),
        tti: getDisplay("interactive"),
        ttfb: getDisplay("server-response-time"),
      },
      opportunities: opps,
    };
  }

  const m = results.mobile as Record<string, unknown> | undefined;
  const d = results.desktop as Record<string, unknown> | undefined;
  const lines = [`PageSpeed Insights for ${url}:`];
  for (const [label, r] of [["Mobile", m], ["Desktop", d]] as const) {
    if (!r) continue;
    if (r.error) { lines.push(`  ${label}: error — ${r.error}`); continue; }
    lines.push(`  ${label}: Performance ${r.performanceScore ?? "n/a"}/100, SEO ${r.seoScore ?? "n/a"}/100`);
  }

  return ok(lines.join(" | "), { url, mobile: m ?? null, desktop: d ?? null });
};

// ---------------------------------------------------------------------------
// 2. Schema / Rich Results validation
// ---------------------------------------------------------------------------

export const runSchemaValidate = async (rawUrl: string): Promise<OkResult | FailResult> => {
  const resolved = safeUrl(rawUrl);
  if (!("url" in resolved)) return resolved;
  const url = resolved.url.toString();

  const res = await timedFetch(url, { timeoutMs: 15_000 });
  if (!res || !res.ok) return fail("fetch_failed", `Could not fetch the page (${res?.status ?? "timeout"}).`, true);

  const html = await res.text();

  // Extract all JSON-LD blocks
  const jsonLdBlocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) jsonLdBlocks.push(...parsed);
      else jsonLdBlocks.push(parsed);
    } catch { /* malformed */ }
  }

  const typesFound: string[] = jsonLdBlocks.flatMap((b) => {
    const block = b as Record<string, unknown>;
    const t = block["@type"];
    return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
  });

  const HIGH_VALUE = [
    "LocalBusiness", "MedicalBusiness", "Physician", "MedicalOrganization",
    "Dentist", "Organization", "WebSite", "WebPage", "FAQPage",
    "BreadcrumbList", "Article", "BlogPosting", "Product", "Review",
    "AggregateRating", "Event", "HowTo",
  ];
  const present = HIGH_VALUE.filter((t) => typesFound.includes(t));
  const missing = HIGH_VALUE.filter((t) => !typesFound.includes(t));

  const issues: string[] = [];
  for (const block of jsonLdBlocks) {
    const b = block as Record<string, unknown>;
    const type = String(b["@type"] ?? "");
    if (["LocalBusiness", "MedicalBusiness", "Physician", "MedicalOrganization", "Dentist"].includes(type)) {
      if (!b.name) issues.push(`${type} missing 'name'`);
      if (!b.address) issues.push(`${type} missing 'address'`);
      if (!b.telephone) issues.push(`${type} missing 'telephone'`);
      if (!b.geo && !b.hasMap) issues.push(`${type} missing geo coordinates`);
    }
    if (type === "FAQPage") {
      const entries = Array.isArray(b.mainEntity) ? b.mainEntity.length : 0;
      if (entries < 3) issues.push(`FAQPage has only ${entries} Q&A entries — more improves AI citation likelihood`);
    }
  }

  const summary = jsonLdBlocks.length === 0
    ? `No JSON-LD structured data found on ${url}. Significant AI visibility gap.`
    : `Found ${jsonLdBlocks.length} JSON-LD block(s): ${typesFound.join(", ") || "types undetected"}. ${issues.length} issue(s).`;

  return ok(summary, {
    url,
    blockCount: jsonLdBlocks.length,
    typesFound,
    highValuePresent: present,
    highValueMissing: missing,
    issues,
    blocks: jsonLdBlocks.slice(0, 5),
  });
};

// ---------------------------------------------------------------------------
// 3. Sitemap audit
// ---------------------------------------------------------------------------

type SitemapEntry = { loc: string; lastmod: string | null; changefreq: string | null; priority: string | null };

const parseSitemapXml = (xml: string): { urls: SitemapEntry[]; refs: string[] } => {
  const urls: SitemapEntry[] = [];
  const refs: string[] = [];

  // Sitemap index entries
  for (const block of xml.matchAll(/<sitemap>[\s\S]*?<\/sitemap>/gi)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(block[0])?.[1]?.trim();
    if (loc) refs.push(loc);
  }

  // URL entries
  for (const block of xml.matchAll(/<url>[\s\S]*?<\/url>/gi)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(block[0])?.[1]?.trim();
    if (!loc) continue;
    urls.push({
      loc,
      lastmod: /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(block[0])?.[1]?.trim() ?? null,
      changefreq: /<changefreq>([\s\S]*?)<\/changefreq>/i.exec(block[0])?.[1]?.trim() ?? null,
      priority: /<priority>([\s\S]*?)<\/priority>/i.exec(block[0])?.[1]?.trim() ?? null,
    });
  }
  return { urls, refs };
};

const processSitemapXml = async (xml: string, sitemapUrl: string, host: string): Promise<OkResult> => {
  const { urls, refs } = parseSitemapXml(xml);

  // Follow child sitemaps one level deep
  const childUrls: SitemapEntry[] = [];
  for (const ref of refs.slice(0, 10)) {
    const r = await timedFetch(ref, { timeoutMs: 8_000 });
    if (!r?.ok) continue;
    const childXml = await r.text();
    childUrls.push(...parseSitemapXml(childXml).urls);
  }

  const all = [...urls, ...childUrls];
  const now = Date.now();
  const recent = all.filter((u) => {
    if (!u.lastmod) return false;
    const d = new Date(u.lastmod).getTime();
    return !isNaN(d) && now - d < 60 * 24 * 60 * 60 * 1000;
  });

  const issues: string[] = [];
  if (all.length === 0) issues.push("Sitemap exists but contains no URLs");
  else if (all.length <= 5) issues.push(`Only ${all.length} URL(s) — unusually thin for an optimized site`);
  const noLastmod = all.filter((u) => !u.lastmod).length;
  if (noLastmod > 0) issues.push(`${noLastmod} URL(s) missing lastmod dates`);
  const external = all.filter((u) => !u.loc.includes(host)).length;
  if (external > 0) issues.push(`${external} URL(s) point to a different domain`);

  return ok(
    `Sitemap at ${sitemapUrl}: ${all.length} URL(s), ${recent.length} updated in last 60 days. ${issues.length} issue(s).`,
    { sitemapUrl, totalUrls: all.length, childSitemaps: refs.length, recentlyUpdated: recent.length, issues, urls: all.slice(0, 50), sitemapRefs: refs },
  );
};

export const runSitemapAudit = async (rawUrl: string): Promise<OkResult | FailResult> => {
  const resolved = safeUrl(rawUrl);
  if (!("url" in resolved)) return resolved;
  const base = resolved.url;
  const host = base.host;

  // Check robots.txt for Sitemap: directive
  let sitemapUrl = `${base.protocol}//${host}/sitemap.xml`;
  const robotsRes = await timedFetch(`${base.protocol}//${host}/robots.txt`, { timeoutMs: 8_000 });
  if (robotsRes?.ok) {
    const text = await robotsRes.text();
    const line = text.split("\n").find((l) => l.toLowerCase().startsWith("sitemap:"));
    if (line) sitemapUrl = line.split(":").slice(1).join(":").trim();
  }

  // Try primary URL then fallbacks
  const candidates = [sitemapUrl, `${base.protocol}//${host}/sitemap_index.xml`, `${base.protocol}//${host}/sitemap`];
  for (const candidate of candidates) {
    const r = await timedFetch(candidate, { timeoutMs: 10_000 });
    if (r?.ok) {
      const xml = await r.text();
      return processSitemapXml(xml, candidate, host);
    }
  }

  return fail("sitemap_not_found",
    `No sitemap found at ${sitemapUrl} or standard fallback locations. This is a crawlability gap.`, false);
};

// ---------------------------------------------------------------------------
// 4. Google Search Console
// ---------------------------------------------------------------------------

/**
 * Try a GSC Search Analytics query against a property string.
 * Returns the raw response JSON on success, null on any failure.
 */
const gscAnalyticsQuery = async (
  property: string,
  startDate: string,
  endDate: string,
  token: string,
): Promise<Record<string, unknown> | null> => {
  const res = await timedFetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["page", "query"], rowLimit: 25 }),
      timeoutMs: 15_000,
    },
  );
  if (!res?.ok) return null;
  try { return await res.json() as Record<string, unknown>; } catch { return null; }
};

/** URL Inspection API — returns inspection result or null. */
const gscInspect = async (
  property: string,
  inspectionUrl: string,
  token: string,
): Promise<Record<string, unknown> | null> => {
  const res = await timedFetch(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl: property }),
      timeoutMs: 15_000,
    },
  );
  if (!res?.ok) return null;
  try { return await res.json() as Record<string, unknown>; } catch { return null; }
};

export const runSearchConsole = async (rawUrl: string, gscToken: string | null): Promise<OkResult | FailResult> => {
  const resolved = safeUrl(rawUrl);
  if (!("url" in resolved)) return resolved;
  const url = resolved.url.toString();

  if (!gscToken) {
    return fail(
      "no_gsc_credential",
      "Google Search Console access requires a service account key stored in Access & Connections. Add it there first.",
      false,
    );
  }

  const host = resolved.url.host.replace(/^www\./, "");
  const domainProperty = `sc-domain:${host}`;
  // URL-prefix property is the canonical origin (scheme + host, no path)
  const originProperty = `${resolved.url.protocol}//${resolved.url.host}/`;

  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  // Try sc-domain first (broader, covers all URL variants). Fall back to URL-prefix.
  let analyticsData = await gscAnalyticsQuery(domainProperty, start, end, gscToken);
  let activeProperty = domainProperty;
  if (!analyticsData) {
    analyticsData = await gscAnalyticsQuery(originProperty, start, end, gscToken);
    if (analyticsData) activeProperty = originProperty;
  }

  // URL inspection via the v1 API
  const inspectData = await gscInspect(activeProperty, url, gscToken);

  const rows = (analyticsData?.rows as Array<Record<string, unknown>>) ?? [];

  // Aggregate totals
  const clicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const impressions = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  const avgCtr = rows.length > 0
    ? rows.reduce((s, r) => s + (Number(r.ctr) || 0), 0) / rows.length
    : 0;
  const avgPosition = rows.length > 0
    ? rows.reduce((s, r) => s + (Number(r.position) || 0), 0) / rows.length
    : 0;

  // Top pages by clicks
  const topPages = rows
    .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0))
    .slice(0, 10)
    .map((r) => ({
      page: String((r.keys as string[])?.[0] ?? ""),
      query: String((r.keys as string[])?.[1] ?? ""),
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      ctr: Number(r.ctr) || 0,
      position: Number(r.position) || 0,
    }));

  const indexResult = inspectData?.inspectionResult as Record<string, unknown> | null;
  const indexStatusResult = indexResult?.indexStatusResult as Record<string, unknown> | null;
  const indexStatus = String(indexStatusResult?.coverageState ?? "Unknown");
  const robotsAllowed = indexStatusResult?.robotsTxtState === "ALLOWED";
  const lastCrawl = String(indexStatusResult?.lastCrawlTime ?? "");

  const issues: string[] = [];
  if (!analyticsData) issues.push("Search Analytics unavailable — service account may not have property access.");
  if (avgPosition > 20) issues.push(`Average position ${avgPosition.toFixed(1)} — most content is past page 2.`);
  if (avgCtr < 0.02 && impressions > 100) issues.push("CTR below 2% — titles and meta descriptions likely need work.");
  if (!robotsAllowed && indexStatus !== "Unknown") issues.push("robots.txt may be blocking indexing.");

  const summaryParts: string[] = [];
  if (analyticsData) {
    summaryParts.push(
      `GSC (90d): ${clicks.toLocaleString()} clicks, ${impressions.toLocaleString()} impressions across ${rows.length} pages`,
      `avg position ${avgPosition.toFixed(1)}, avg CTR ${(avgCtr * 100).toFixed(1)}%`,
    );
  } else {
    summaryParts.push("GSC Search Analytics unavailable");
  }
  summaryParts.push(`Index: ${indexStatus}`);
  if (issues.length) summaryParts.push(`${issues.length} issue(s) flagged`);

  return ok(summaryParts.join(" · "), {
    property: activeProperty,
    propertyFallback: activeProperty === originProperty,
    indexStatus,
    robotsAllowed,
    lastCrawl,
    last90Days: { clicks, impressions, avgCtr, avgPosition, topPages },
    issues,
    coverageData: indexStatusResult,
  });
};

// ---------------------------------------------------------------------------
// 5. Security headers
// ---------------------------------------------------------------------------

export const runSecurityHeaders = async (rawUrl: string): Promise<OkResult | FailResult> => {
  const resolved = safeUrl(rawUrl);
  if (!("url" in resolved)) return resolved;
  const url = resolved.url.toString();

  // Try HEAD first, fall back to GET
  let res = await timedFetch(url, { method: "HEAD", timeoutMs: 10_000 });
  if (!res || !res.ok) res = await timedFetch(url, { timeoutMs: 10_000 });
  if (!res || !res.ok) return fail("fetch_failed", `Could not reach ${url}.`, true);

  const h = res.headers;
  const get = (name: string) => h.get(name);

  const checks = [
    {
      header: "Strict-Transport-Security",
      value: get("strict-transport-security"),
      grade: get("strict-transport-security") ? "pass" : "fail",
      note: get("strict-transport-security") ? "HSTS present" : "HSTS missing — HTTP downgrade risk",
    },
    {
      header: "X-Frame-Options",
      value: get("x-frame-options"),
      grade: get("x-frame-options") ? "pass" : "warn",
      note: get("x-frame-options") ? "Clickjacking protection present" : "X-Frame-Options missing",
    },
    {
      header: "Content-Security-Policy",
      value: get("content-security-policy")?.slice(0, 120) ?? null,
      grade: get("content-security-policy") ? "pass" : "warn",
      note: get("content-security-policy") ? "CSP present" : "No CSP — XSS risk",
    },
    {
      header: "X-Content-Type-Options",
      value: get("x-content-type-options"),
      grade: get("x-content-type-options") === "nosniff" ? "pass" : "warn",
      note: get("x-content-type-options") === "nosniff" ? "MIME sniffing disabled" : "X-Content-Type-Options not set",
    },
    {
      header: "Referrer-Policy",
      value: get("referrer-policy"),
      grade: get("referrer-policy") ? "pass" : "warn",
      note: get("referrer-policy") ? `Referrer-Policy: ${get("referrer-policy")}` : "No Referrer-Policy",
    },
    {
      header: "Permissions-Policy",
      value: get("permissions-policy")?.slice(0, 80) ?? null,
      grade: get("permissions-policy") ? "pass" : "warn",
      note: get("permissions-policy") ? "Permissions-Policy present" : "No Permissions-Policy",
    },
    {
      header: "Server",
      value: get("server"),
      grade: get("server") ? "warn" : "pass",
      note: get("server") ? `Server reveals: ${get("server")}` : "Server header hidden",
    },
  ] as const;

  const passes = checks.filter((c) => c.grade === "pass").length;
  const warns  = checks.filter((c) => c.grade === "warn").length;
  const fails  = checks.filter((c) => c.grade === "fail").length;
  const letter = fails > 0 ? "D" : warns > 3 ? "C" : warns > 1 ? "B" : "A";

  return ok(
    `Security headers for ${url}: Grade ${letter} — ${passes} pass, ${warns} warn, ${fails} fail.`,
    { url, grade: letter, passes, warns, fails, checks },
  );
};
