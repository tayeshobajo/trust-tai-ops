import "./hermetic-env.ts";

/**
 * Executable validation for the read-only browser inspection boundary.
 *
 * Run with: npm run check:browser
 *
 * Guards the rules that make loading a page safe: only this project's own site,
 * never a private address, never an unsafe redirect, never an unbounded or
 * unredacted report, and an honest refusal when no rendering service exists.
 */

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const { checkInspectionTarget, normalizeBrowserReport, runBrowserInspection, BROWSER_VIEWPORTS, isBrowserViewport } =
  await import("../supabase/functions/_shared/browserInspect.ts");
const { TOOL_REGISTRY, planAction } = await import("../src/agent-core/registry.ts");
const { classifyRisk, isToolEligibleForStack } = await import("../src/agent-core/policy.ts");

console.log("\ntool declaration");
check("page inspection is read only", classifyRisk("browser.inspect_page_readonly") === "read_only");
check("page inspection stays read only in the registry", TOOL_REGISTRY["browser.inspect_page_readonly"].readOnly);
check(
  "page inspection is stack neutral",
  isToolEligibleForStack("browser.inspect_page_readonly", "meteor") &&
    isToolEligibleForStack("browser.inspect_page_readonly", "wordpress"),
);
check("only two viewports exist", Object.keys(BROWSER_VIEWPORTS).join(",") === "desktop,mobile");
check("unknown viewports are refused", !isBrowserViewport("watch") && isBrowserViewport("mobile"));

console.log("\nplanned arguments");
const planned = planAction("inspect-page-mobile", "browser.inspect_page_readonly", "run-1", {
  url: "https://example.com/shop",
  viewport: "mobile",
  script: "document.cookie",
});
check("action builds", !("error" in planned));
if (!("error" in planned)) {
  check("no free-text argument survives validation", !("script" in planned.args));
  check("viewport is preserved", planned.args.viewport === "mobile");
  check("invocation key is deterministic", planned.invocationKey.includes("browser.inspect_page_readonly"));
}
check(
  "an unsafe address is refused at plan time",
  "error" in planAction("x", "browser.inspect_page_readonly", "run-1", { url: "http://169.254.169.254/" }),
);

console.log("\ntarget scoping");
const site = "https://example.com/";
for (const bad of [
  "http://127.0.0.1/",
  "http://10.0.0.4/",
  "http://169.254.169.254/latest/meta-data/",
  "file:///etc/passwd",
  "https://evil.test/",
  "https://user:pass@example.com/",
]) {
  check(`refuses ${bad}`, checkInspectionTarget(bad, site).ok === false);
}
check("accepts the project's own page", checkInspectionTarget("https://example.com/cart", site).ok === true);
check("accepts the project's own subdomain", checkInspectionTarget("https://shop.example.com/", site).ok === true);
check(
  "refuses a lookalike domain",
  checkInspectionTarget("https://notexample.com/", site).ok === false,
);

console.log("\nreport normalization");
const normalized = normalizeBrowserReport(
  {
    status: 200,
    ttfbMs: 410.6,
    domContentLoadedMs: 1200,
    loadEventMs: 5200,
    transferBytes: 1_200_000,
    requestCount: 84,
    finalUrl: "https://example.com/cart",
    consoleErrors: Array.from({ length: 40 }, (_, index) => `error ${index} token=supersecretvalue0000`),
    failedRequests: [{ url: "https://cdn.example.com/app.js", status: 404 }],
    secretHeaders: { authorization: "Bearer abcdefghijklmnop" },
  },
  { viewport: "desktop", allowedUrl: site },
);
check("a well-formed report normalizes", normalized.ok === true);
if (normalized.ok) {
  const report = normalized.report;
  check("console errors are bounded", report.consoleErrors.length === 10);
  check("truncation is reported honestly", report.truncated === true);
  check(
    "secrets never survive into evidence",
    !JSON.stringify(report).includes("supersecretvalue") && !JSON.stringify(report).includes("abcdefghijklmnop"),
  );
  check("unknown fields are dropped", !("secretHeaders" in (report as unknown as Record<string, unknown>)));
  check("failed requests keep only the host", report.failedRequests[0].host === "cdn.example.com");
  check("timings are numeric and rounded", report.ttfbMs === 411 && report.loadEventMs === 5200);
}
const escaped = normalizeBrowserReport(
  { status: 200, finalUrl: "https://phish.test/" },
  { viewport: "desktop", allowedUrl: site },
);
check("a redirect off the project's site invalidates the report", escaped.ok === false);
check(
  "a redirect into a private address invalidates the report",
  normalizeBrowserReport({ finalUrl: "http://127.0.0.1/" }, { viewport: "desktop", allowedUrl: site }).ok === false,
);

console.log("\nadapter honesty");
const unconfigured = await runBrowserInspection(
  { endpoint: null, token: null },
  { url: site, viewport: "desktop", allowedUrl: site },
  (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch,
);
check("no rendering service means an honest refusal", !unconfigured.ok && unconfigured.code === "tool_unavailable");
check("nothing is simulated", !unconfigured.ok && !/simulat|probably|likely/i.test(unconfigured.summary));

const insecureEndpoint = await runBrowserInspection(
  { endpoint: "http://render.test/", token: null },
  { url: site, viewport: "desktop", allowedUrl: site },
  (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch,
);
check("a non-https rendering service is refused", !insecureEndpoint.ok && insecureEndpoint.code === "tool_unavailable");

let sentBody: Record<string, unknown> = {};
const stubFetch = (async (_url: string, init: RequestInit) => {
  sentBody = JSON.parse(String(init.body));
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 200, ttfbMs: 300, loadEventMs: 1500, requestCount: 20, transferBytes: 400_000, finalUrl: site }),
    body: null,
  } as unknown as Response;
}) as unknown as typeof fetch;

const live = await runBrowserInspection(
  { endpoint: "https://render.test/inspect", token: "t" },
  { url: "https://example.com/cart", viewport: "mobile", allowedUrl: site },
  stubFetch,
);
check("a configured service produces real evidence", live.ok === true);
check("the request carries only a url and a fixed viewport", Object.keys(sentBody).sort().join(",") === "readOnly,url,viewport");
check("the viewport sent is the catalog one", JSON.stringify(sentBody.viewport) === JSON.stringify({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true }));

const offSite = await runBrowserInspection(
  { endpoint: "https://render.test/inspect", token: "t" },
  { url: "https://evil.test/", viewport: "desktop", allowedUrl: site },
  (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch,
);
check("an unrelated domain never reaches the service", !offSite.ok && offSite.code === "unsafe_destination");

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("All browser inspection checks passed.");

// --- browserless dialect -----------------------------------------------------

console.log("\nbrowserless dialect");
{
  let seen: { url: string; body: any } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), body: JSON.parse(String(init.body)) };
    return new Response(
      JSON.stringify({ data: { finalUrl: "https://example.com/", status: 200, loadEventMs: 1200, consoleErrors: [], failedRequests: [] }, type: "application/json" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const outcome = await runBrowserInspection(
    { endpoint: "https://production-sfo.browserless.io/function", token: "tok-123" },
    { url: "https://example.com/", viewport: "desktop", allowedUrl: "https://example.com" },
    fetchImpl,
  );

  check("a browserless report unwraps and normalizes", outcome.ok === true);
  check("the token travels as a query parameter, never a header", seen!.url.includes("token=tok-123"));
  check("the page script is sent as code with a bounded context", typeof seen!.body.code === "string" && seen!.body.context.url === "https://example.com/");
  check("the page script only navigates and reads", !/\.click\(|\.type\(|\.evaluate\(\s*\(\)\s*=>\s*\{[^}]*document\.\w+\s*=/.test(seen!.body.code));
}
