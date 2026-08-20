/**
 * Stack-neutral, read-only page inspection boundary.
 *
 * A real browser cannot run inside the edge runtime, so this module owns the
 * *rules* and delegates the actual page load to an external, explicitly
 * configured rendering service. When no service is configured the tool reports
 * `tool_unavailable` honestly — nothing here is ever simulated.
 *
 * Pure TypeScript on purpose: no Deno globals and no npm specifiers, so the
 * exact code that runs in production is exercised by `npm run check:browser`.
 */

import { redact, validatePublicUrl } from "./net.ts";

export type BrowserViewportId = "desktop" | "mobile";

export const BROWSER_VIEWPORTS: Record<
  BrowserViewportId,
  { width: number; height: number; deviceScaleFactor: number; mobile: boolean; label: string }
> = {
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false, label: "desktop" },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, label: "mobile" },
};

export const isBrowserViewport = (value: unknown): value is BrowserViewportId =>
  value === "desktop" || value === "mobile";

export type TargetCheck =
  | { ok: true; url: URL }
  | { ok: false; code: "invalid_input" | "unsafe_destination"; reason: string };

const sameSite = (candidate: URL, allowed: URL): boolean => {
  const a = candidate.hostname.toLowerCase().replace(/\.$/, "");
  const b = allowed.hostname.toLowerCase().replace(/\.$/, "");
  return a === b || a.endsWith(`.${b}`);
};

/**
 * The only addresses this tool may load: a public destination that belongs to
 * the project itself. An unrelated domain is refused even when it is public,
 * so the agent can never be pointed at someone else's site.
 */
export const checkInspectionTarget = (raw: string, allowedUrl: string | null): TargetCheck => {
  const check = validatePublicUrl(typeof raw === "string" ? raw.trim() : "");
  if (!check.ok) {
    const unsafe = /private network/i.test(check.reason);
    return { ok: false, code: unsafe ? "unsafe_destination" : "invalid_input", reason: check.reason };
  }
  if (check.url.username || check.url.password) {
    return { ok: false, code: "unsafe_destination", reason: "Addresses with embedded credentials are not accepted." };
  }
  if (check.url.toString().length > 512) {
    return { ok: false, code: "invalid_input", reason: "That address is too long to inspect." };
  }
  if (allowedUrl) {
    const allowed = validatePublicUrl(allowedUrl);
    if (!allowed.ok) {
      return { ok: false, code: "unsafe_destination", reason: "I don't have a safe site address for this project." };
    }
    if (!sameSite(check.url, allowed.url)) {
      return {
        ok: false,
        code: "unsafe_destination",
        reason: "That address is not part of this project's site, so I won't load it.",
      };
    }
  }
  return { ok: true, url: check.url };
};

// --- report normalization ----------------------------------------------------

const num = (value: unknown, max: number): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), max);
};

const line = (value: unknown, limit = 200): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = redact(value).replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, limit) : null;
};

export type BrowserReport = {
  viewport: BrowserViewportId;
  finalUrl: string | null;
  status: number | null;
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  transferBytes: number | null;
  requestCount: number | null;
  consoleErrors: string[];
  failedRequests: Array<{ host: string; status: number | null }>;
  elementMatches: Array<{ text: string; html: string; tag: string; classes: string; href: string | null }>;
  truncated: boolean;
};

export type NormalizedReport = { ok: true; report: BrowserReport } | { ok: false; reason: string };

const MAX_CONSOLE_ERRORS = 10;
const MAX_FAILED_REQUESTS = 10;
const MAX_ELEMENT_MATCHES = 5;
const MAX_ELEMENT_HTML_CHARS = 600;

/** A bounded, sanitized search term for page-content inspection. */
export const sanitizeElementQuery = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 120);
  if (!trimmed) return null;
  // No control characters, no null bytes; printable search text only.
  if (/[\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
};

/**
 * Whatever the rendering service returns is treated as untrusted data: only
 * known fields survive, every string is redacted and bounded, and a final URL
 * that has escaped the project's own site invalidates the whole report.
 */
export const normalizeBrowserReport = (
  payload: unknown,
  options: { viewport: BrowserViewportId; allowedUrl: string | null },
): NormalizedReport => {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "The page checker returned nothing usable." };
  const raw = payload as Record<string, unknown>;

  let finalUrl: string | null = null;
  if (typeof raw.finalUrl === "string" && raw.finalUrl.trim()) {
    const target = checkInspectionTarget(raw.finalUrl, options.allowedUrl);
    if (!target.ok) {
      return { ok: false, reason: "The page redirected somewhere outside this project's site, so I stopped." };
    }
    finalUrl = target.url.toString();
  }

  const consoleSource = Array.isArray(raw.consoleErrors) ? raw.consoleErrors : [];
  const consoleErrors = consoleSource
    .map((entry) => line(typeof entry === "string" ? entry : (entry as Record<string, unknown>)?.text))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, MAX_CONSOLE_ERRORS);

  const failedSource = Array.isArray(raw.failedRequests) ? raw.failedRequests : [];
  const failedRequests = failedSource
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const url = typeof item.url === "string" ? item.url : "";
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        host = line(url, 80) ?? "";
      }
      if (!host) return null;
      return { host: host.slice(0, 120), status: num(item.status, 599) };
    })
    .filter((entry): entry is { host: string; status: number | null } => entry !== null)
    .slice(0, MAX_FAILED_REQUESTS);

  const elementSource = Array.isArray(raw.elementMatches) ? raw.elementMatches : [];
  const elementMatches = elementSource
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const html = typeof item.html === "string" ? item.html.slice(0, MAX_ELEMENT_HTML_CHARS) : "";
      if (!html) return null;
      return {
        text: line(item.text, 160) ?? "",
        html,
        tag: line(item.tag, 40) ?? "",
        classes: line(item.classes, 160) ?? "",
        href: line(item.href, 300),
      };
    })
    .filter((entry): entry is { text: string; html: string; tag: string; classes: string; href: string | null } => entry !== null)
    .slice(0, MAX_ELEMENT_MATCHES);

  return {
    ok: true,
    report: {
      viewport: options.viewport,
      finalUrl,
      status: num(raw.status, 599),
      ttfbMs: num(raw.ttfbMs, 600_000),
      domContentLoadedMs: num(raw.domContentLoadedMs, 600_000),
      loadEventMs: num(raw.loadEventMs, 600_000),
      transferBytes: num(raw.transferBytes, 500_000_000),
      requestCount: num(raw.requestCount, 5_000),
      consoleErrors,
      failedRequests,
      elementMatches,
      truncated: consoleSource.length > MAX_CONSOLE_ERRORS || failedSource.length > MAX_FAILED_REQUESTS || elementSource.length > MAX_ELEMENT_MATCHES,
    },
  };
};

// --- adapter -----------------------------------------------------------------

export type BrowserServiceConfig = {
  /** Absolute https endpoint of the rendering service. Null when unconfigured. */
  endpoint: string | null;
  token: string | null;
  timeoutMs?: number;
  /**
   * Wire format of the service. "browserless" speaks Browserless v2's
   * `/function` API; "generic" posts our own request shape to a service that
   * already returns a report. Detected from the endpoint when omitted.
   */
  dialect?: "generic" | "browserless";
};

export type BrowserInspectOutcome =
  | { ok: true; summary: string; data: Record<string, unknown> }
  | { ok: false; code: string; summary: string; retryable: boolean };

export const BROWSER_UNAVAILABLE_SUMMARY =
  "I can load pages in a real browser only when a rendering service is connected, and one isn't configured here yet.";

const describe = (report: BrowserReport): string => {
  const seconds = (ms: number | null) => (ms === null ? null : `${(ms / 1000).toFixed(1)}s`);
  const load = seconds(report.loadEventMs) ?? seconds(report.domContentLoadedMs);
  const parts = [`I loaded the page in a real browser on ${BROWSER_VIEWPORTS[report.viewport].label}.`];
  if (report.status !== null) parts.push(`It answered ${report.status}.`);
  if (load) parts.push(`It finished loading in about ${load}.`);
  if (report.elementMatches.length > 0) {
    parts.push(`I found ${report.elementMatches.length} page element(s) matching the search${report.elementMatches[0]?.text ? `, first: "${report.elementMatches[0].text}"` : ""}.`);
  } else if (report.elementMatches !== undefined && report.elementMatches.length === 0) {
    parts.push("No page elements matched the search.");
  }
  if (report.consoleErrors.length > 0) parts.push(`${report.consoleErrors.length} console errors were reported.`);
  return parts.join(" ");
};

/**
 * The page script Browserless runs. It only reads: it navigates once, waits
 * for the load to settle, and reports timings, console errors and failed
 * requests. It never clicks, types, or submits anything. When an elementQuery
 * is supplied it also returns bounded excerpts of matching page elements —
 * never the whole page HTML.
 */
export const BROWSERLESS_FUNCTION_SOURCE = `
export default async function ({ page, context }) {
  const { url, viewport, elementQuery } = context;
  const consoleErrors = [];
  const failedRequests = [];
  await page.setViewport(viewport);
  page.on("console", (msg) => {
    if (msg.type() === "error" && consoleErrors.length < 25) consoleErrors.push(String(msg.text()));
  });
  page.on("requestfailed", (req) => {
    if (failedRequests.length < 25) failedRequests.push({ url: req.url(), status: null });
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && failedRequests.length < 25) {
      failedRequests.push({ url: res.url(), status: res.status() });
    }
  });
  const started = Date.now();
  const response = await page.goto(url, { waitUntil: "load", timeout: 30000 });
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    return {
      ttfbMs: nav ? nav.responseStart : null,
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      loadEventMs: nav ? nav.loadEventEnd : null,
      requestCount: resources.length + 1,
      transferBytes: resources.reduce((total, entry) => total + (entry.transferSize || 0), 0),
    };
  });
  let elementMatches = [];
  if (elementQuery) {
    elementMatches = await page.evaluate((query) => {
      // Tokenize query into meaningful words (≥2 chars).
      const queryTokens = String(query).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
      const threshold = Math.max(1, Math.ceil(queryTokens.length * 0.6));
      // A "strong" token is one long enough to be distinctive on its own (≥3 chars).
      const strongTokens = queryTokens.filter((t) => t.length >= 3);

      const score = (el) => {
        const text = (el.textContent || "").trim().toLowerCase();
        const classes = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "").toLowerCase();
        const combined = text + " " + classes;
        // Exact substring: highest confidence.
        if (combined.includes(String(query).toLowerCase())) return 3;
        // Word-overlap: count how many query tokens appear anywhere in the element text+classes.
        const matched = queryTokens.filter((t) => combined.includes(t));
        if (matched.length >= threshold) return 2;
        // Strong-token match: any single distinctive query word (≥3 chars) appears.
        if (strongTokens.some((t) => combined.includes(t))) return 1;
        return 0;
      };

      const all = Array.from(document.querySelectorAll("a, button, input, [class]"));
      const scored = all.map((el) => ({ el, s: score(el) })).filter((entry) => entry.s > 0);
      // Sort descending by score, keep top 5.
      scored.sort((a, b) => b.s - a.s);
      return scored.slice(0, 5).map(({ el }) => ({
        text: (el.textContent || "").trim().slice(0, 160),
        html: el.outerHTML.slice(0, 600),
        tag: el.tagName.toLowerCase(),
        classes: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "").slice(0, 160),
        href: el.getAttribute("href") ? el.getAttribute("href").slice(0, 300) : null,
      }));
    }, elementQuery);
  }
  return {
    data: {
      finalUrl: page.url(),
      status: response ? response.status() : null,
      ttfbMs: timing.ttfbMs,
      domContentLoadedMs: timing.domContentLoadedMs,
      loadEventMs: timing.loadEventMs === 0 ? Date.now() - started : timing.loadEventMs,
      transferBytes: timing.transferBytes,
      requestCount: timing.requestCount,
      consoleErrors,
      failedRequests,
      elementMatches,
    },
    type: "application/json",
  };
}
`;

const dialectOf = (config: BrowserServiceConfig, endpoint: URL): "generic" | "browserless" =>
  config.dialect ?? (/browserless/i.test(endpoint.hostname) || endpoint.pathname.endsWith("/function")
    ? "browserless"
    : "generic");

/**
 * Runs one read-only page inspection through the configured rendering service.
 * Never navigates anywhere the caller did not prove is part of the project.
 */
export const runBrowserInspection = async (
  config: BrowserServiceConfig,
  request: { url: string; viewport: BrowserViewportId; allowedUrl: string | null; elementQuery?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserInspectOutcome> => {
  if (!config.endpoint) {
    return { ok: false, code: "tool_unavailable", summary: BROWSER_UNAVAILABLE_SUMMARY, retryable: false };
  }
  const endpoint = validatePublicUrl(config.endpoint);
  if (!endpoint.ok || endpoint.url.protocol !== "https:") {
    return {
      ok: false,
      code: "tool_unavailable",
      summary: "The configured page checker address isn't usable, so I won't call it.",
      retryable: false,
    };
  }

  const target = checkInspectionTarget(request.url, request.allowedUrl);
  if (!target.ok) return { ok: false, code: target.code, summary: target.reason, retryable: false };

  const viewport = BROWSER_VIEWPORTS[request.viewport];
  const dialect = dialectOf(config, endpoint.url);
  const elementQuery = sanitizeElementQuery(request.elementQuery) ?? undefined;
  const requestUrl = new URL(endpoint.url.toString());
  if (dialect === "browserless" && config.token) requestUrl.searchParams.set("token", config.token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 45_000);

  let response: Response;
  try {
    response = await fetchImpl(requestUrl.toString(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(config.token && dialect === "generic" ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(
        dialect === "browserless"
          ? {
              code: BROWSERLESS_FUNCTION_SOURCE,
              context: {
                url: target.url.toString(),
                viewport: {
                  width: viewport.width,
                  height: viewport.height,
                  deviceScaleFactor: viewport.deviceScaleFactor,
                  isMobile: viewport.mobile,
                  hasTouch: viewport.mobile,
                },
                ...(elementQuery ? { elementQuery } : {}),
              },
            }
          : {
              url: target.url.toString(),
              viewport: {
                width: viewport.width,
                height: viewport.height,
                deviceScaleFactor: viewport.deviceScaleFactor,
                mobile: viewport.mobile,
              },
              readOnly: true,
              ...(elementQuery ? { elementQuery } : {}),
            },
      ),
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "timeout" : "network_error",
      summary: aborted
        ? "The page didn't finish loading in a real browser before I ran out of time."
        : "I couldn't reach the page checker, so I have nothing observed to report.",
      retryable: true,
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "tool_unavailable" : "network_error",
      summary: "The page checker refused the request, so I have nothing observed to report.",
      retryable: response.status >= 500,
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  // Browserless wraps whatever the page script returned in `data`.
  if (
    dialect === "browserless" &&
    payload &&
    typeof payload === "object" &&
    "data" in (payload as Record<string, unknown>)
  ) {
    payload = (payload as Record<string, unknown>).data;
  }

  const normalized = normalizeBrowserReport(payload, {
    viewport: request.viewport,
    allowedUrl: request.allowedUrl ?? target.url.toString(),
  });
  if (!normalized.ok) {
    return { ok: false, code: "unsafe_destination", summary: normalized.reason, retryable: false };
  }

  return {
    ok: true,
    summary: redact(describe(normalized.report)),
    data: normalized.report as unknown as Record<string, unknown>,
  };
};
