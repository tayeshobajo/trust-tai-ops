import "./hermetic-env.ts";

/**
 * Executable validation for the read-only WordPress error-log boundary.
 *
 * Run with: npm run check:logs
 *
 * Everything claimed about this capability is asserted here: no client path,
 * no traversal, no host-wide logs, no unbounded read, no raw secret in
 * persisted evidence, no fabricated error when a log simply does not exist,
 * and no mutation of any kind.
 */

import { Buffer } from "node:buffer";

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const {
  ERROR_LOG_CANDIDATES,
  LOG_MAX_BYTES_PER_FILE,
  LOG_MAX_LINES,
  LOG_MAX_TOTAL_BYTES,
  componentsMentioned,
  countBySeverity,
  eligibleLogPaths,
  parseLogEntries,
  relativeCandidateFrom,
  resolveLogPath,
  sanitizeLogText,
  tailLines,
} = await import("../supabase/functions/_shared/errorLogSafety.ts");

const { readWordPressErrorLog } = await import("../supabase/functions/_shared/errorLog.ts");
const { sealSecret, parseEncryptionKey } = await import("../supabase/functions/_shared/crypto.ts");
const { TOOL_REGISTRY, planAction } = await import("../src/agent-core/registry.ts");
const { describeErrorLog, findingFromEvidence } = await import("../src/agent-core/evidence.ts");
const { WP_CLI_READONLY_COMMAND_IDS } = await import("../src/agent-core/wpCliCommands.ts");

const ROOT = "/var/www/html";
const FP_A = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FP_B = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// --- the candidate set is closed --------------------------------------------

console.log("\ncandidate discovery");

check("every candidate resolves under the WordPress root", eligibleLogPaths(ROOT).every((c) => c.path.startsWith(`${ROOT}/`)));
check("the candidate set is WordPress-scoped only", ERROR_LOG_CANDIDATES.every((c) => !c.startsWith("/")));
check(
  "no host-wide log is a candidate",
  eligibleLogPaths(ROOT).every((c) => !/^\/(var\/log|etc|home|root)\b/.test(c.path)),
);
check("labels stay project-relative, not absolute server paths", eligibleLogPaths(ROOT).every((c) => !c.label.startsWith("/")));
check("no WordPress root means no eligible path at all", eligibleLogPaths(null).length === 0);
check("a relative root is refused", eligibleLogPaths("var/www").length === 0);

const traversals = [
  "../../etc/passwd",
  "wp-content/../../../etc/shadow",
  "/etc/passwd",
  "wp-content/debug.log\u0000.txt",
  "wp-content/$(whoami).log",
  "wp-content/debug.log;cat /etc/passwd",
];
check(
  "traversal and injection candidates are all rejected",
  traversals.every((candidate) => resolveLogPath(ROOT, candidate).ok === false),
);
check(
  "a traversal that lands back inside the root is still refused",
  resolveLogPath(ROOT, "wp-content/../error_log").ok === false,
);
check("a legitimate candidate resolves exactly", (() => {
  const result = resolveLogPath(ROOT, "wp-content/debug.log");
  return result.ok && result.path === "/var/www/html/wp-content/debug.log";
})());
check("a root of / is refused outright", resolveLogPath("/", "error_log").ok === false);

// --- the WP_DEBUG_LOG hint is untrusted --------------------------------------

console.log("\nWP_DEBUG_LOG hint");

check("a hint inside the root becomes a relative candidate", relativeCandidateFrom(ROOT, "/var/www/html/wp-content/custom.log") === "wp-content/custom.log");
check("a hint outside the root is discarded", relativeCandidateFrom(ROOT, "/var/log/php-fpm.log") === null);
check("a boolean WP_DEBUG_LOG value is discarded", relativeCandidateFrom(ROOT, "1") === null);
check("a traversal hint is discarded", relativeCandidateFrom(ROOT, "/var/www/html/../../etc/passwd") === null);
check(
  "the debug-log lookup is a catalogued read, not wp eval",
  WP_CLI_READONLY_COMMAND_IDS.includes("config.get_debug_log" as never),
);

// --- redaction ---------------------------------------------------------------

console.log("\nredaction");

const SECRETS = [
  "[10-Aug-2026 10:00:00 UTC] Authorization: Bearer sk_live_abcdef1234567890",
  "[10-Aug-2026 10:00:01 UTC] Cookie: wordpress_logged_in_9f=admin%7C1234%7Csecrethash",
  "[10-Aug-2026 10:00:02 UTC] define('DB_PASSWORD', 'hunter2correcthorse');",
  "[10-Aug-2026 10:00:03 UTC] api_key => 3f9a8c2b7d1e4f5a6b7c8d9e",
  "[10-Aug-2026 10:00:04 UTC] GET https://api.example.com/v1/sync?token=abcd1234efgh&page=2",
  "[10-Aug-2026 10:00:05 UTC] application_password: 'AbCd EfGh IjKl MnOp'",
  `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`,
];
const redacted = sanitizeLogText(SECRETS.join("\n"));

check("bearer tokens are redacted", !redacted.includes("sk_live_abcdef1234567890"));
check("cookies are redacted", !redacted.includes("secrethash"));
check("database passwords are redacted", !redacted.includes("hunter2correcthorse"));
check("api keys are redacted", !redacted.includes("3f9a8c2b7d1e4f5a6b7c8d9e"));
check("secret query parameters are redacted", !redacted.includes("abcd1234efgh"));
check("application passwords are redacted", !redacted.includes("AbCd EfGh IjKl MnOp"));
check("private key material is redacted", !redacted.includes("MIIEowIBAAKCAQEA"));

const DIAGNOSTIC = [
  "[10-Aug-2026 22:14:03 UTC] PHP Fatal error:  Uncaught TypeError: checkout_total(): Argument #1 must be of type float, string given in /var/www/html/wp-content/plugins/checkout-x/includes/cart.php:120",
  "#0 /var/www/html/wp-content/plugins/checkout-x/checkout-x.php(88): checkout_total('abc')",
  "[10-Aug-2026 22:14:04 UTC] PHP Warning:  include(): Failed opening '/var/www/html/wp-content/themes/atlas/parts/hero.php' in /var/www/html/wp-includes/template.php on line 812",
];
const kept = sanitizeLogText(DIAGNOSTIC.join("\n"));
check("plugin paths survive redaction", kept.includes("wp-content/plugins/checkout-x/includes/cart.php"));
check("theme paths survive redaction", kept.includes("wp-content/themes/atlas"));
check("stack frames survive redaction", kept.includes("#0 /var/www/html/wp-content/plugins/checkout-x/checkout-x.php(88)"));
check("line numbers survive redaction", kept.includes("line 812"));
check("timestamps survive redaction", kept.includes("[10-Aug-2026 22:14:03 UTC]"));
check("function names survive redaction", kept.includes("checkout_total"));

// --- bounds and structure ----------------------------------------------------

console.log("\nbounds and structure");

check("per-file budget is 64 KiB", LOG_MAX_BYTES_PER_FILE === 64 * 1024);
check("total budget is 128 KiB", LOG_MAX_TOTAL_BYTES === 128 * 1024);
check("line cap is 300", LOG_MAX_LINES === 300);

const many = Array.from({ length: 1200 }, (_, index) => `line ${index}`).join("\n");
const tail = tailLines(many);
check("only the last 300 lines are kept", tail.length === 300);
check("the tail keeps the newest lines", tail[tail.length - 1] === "line 1199");

const entries = parseLogEntries(tailLines(kept));
check("stack continuation frames fold into their entry", entries.length === 2);
check("severity is parsed from the entry", entries[0]?.severity === "fatal" && entries[1]?.severity === "warning");
check("counts are grouped by severity", countBySeverity(entries).fatal === 1);
const components = componentsMentioned(tailLines(kept));
check("the plugin is identified deterministically", components.some((c) => c.kind === "plugin" && c.name === "checkout-x"));
check("the theme is identified deterministically", components.some((c) => c.kind === "theme" && c.name === "atlas"));

// --- tool contract -----------------------------------------------------------

console.log("\ntool contract");

const tool = TOOL_REGISTRY["wordpress.read_error_log"];
check("the tool is implemented", tool.implemented === true);
check("the tool is read-only", tool.readOnly === true);
check("the tool is classified read_only risk", tool.risk === "read_only");
check("the tool declares the ssh capability it actually uses", tool.capability === "ssh");

const planned = planAction("read-error-log", "wordpress.read_error_log", "run-1", { path: "/etc/passwd" } as never, "Read the log.");
check("planning succeeds without any client argument", !("error" in planned));
if (!("error" in planned)) {
  check("no client-supplied path reaches the executor", JSON.stringify(planned.args) === "{}");
  check("the invocation key is deterministic", planned.invocationKey === planAction("read-error-log", "wordpress.read_error_log", "run-1", {} as never, "Read the log.").invocationKey);
}

// --- end-to-end through a fake SFTP transport --------------------------------

console.log("\nend-to-end boundary");

const KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"b3BlbnNzaC1rZXktdjEAAAAA".repeat(6)}\n-----END OPENSSH PRIVATE KEY-----\n`;
const parsedKey = await parseEncryptionKey(KEY);
if (!parsedKey.ok) throw new Error("test encryption key did not parse");
const sealed = await sealSecret(JSON.stringify({ privateKey: PRIVATE_KEY }), parsedKey.key);

const rowFor = (overrides: Record<string, unknown> = {}) => ({
  id: "row-1",
  project_id: "p1",
  access_type: "ssh",
  provider: "ssh_private_key",
  username: "deploy",
  ciphertext: sealed.ciphertext,
  iv: sealed.iv,
  algorithm: sealed.algorithm,
  key_version: sealed.keyVersion,
  verification_state: "unverified",
  config: { host: "example.com", port: 22, wpRoot: ROOT, wpBinary: "wp" },
  host_fingerprint: FP_A,
  ...overrides,
});

const depsFor = (row: Record<string, unknown> | null) => {
  const verifications: Array<[string, string]> = [];
  return {
    verifications,
    deps: {
      encryptionKey: KEY,
      saveRow: async () => undefined,
      loadRow: async () => row as never,
      markVerification: async (_p: string, accessType: string, state: string) => {
        verifications.push([accessType, state]);
      },
      pinHostFingerprint: async () => undefined,
    },
  };
};

const SAMPLE = [
  "[10-Aug-2026 22:14:00 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function cx_price() in /var/www/html/wp-content/plugins/checkout-x/includes/cart.php:44",
  "#0 /var/www/html/wp-content/plugins/checkout-x/checkout-x.php(88): cx_render()",
  "[10-Aug-2026 22:15:00 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function cx_price() in /var/www/html/wp-content/plugins/checkout-x/includes/cart.php:44",
  "[10-Aug-2026 22:16:00 UTC] Authorization: Bearer sk_live_topsecrettoken",
  "[10-Aug-2026 22:16:01 UTC] define('DB_PASSWORD', 'hunter2correcthorse');",
].join("\n");

type Requested = { paths: string[]; maxBytesPerFile: number; maxTotalBytes: number; accepted: boolean };

const transportFor = (
  files: (paths: readonly string[]) => unknown[],
  presented = FP_A,
) => {
  const requests: Requested[] = [];
  const transport = {
    readTails: async (
      _target: unknown,
      request: { paths: readonly string[]; maxBytesPerFile: number; maxTotalBytes: number },
      _timeoutMs: number,
      acceptHostKey: (fingerprint: string) => boolean,
    ) => {
      const accepted = acceptHostKey(presented);
      requests.push({ paths: [...request.paths], maxBytesPerFile: request.maxBytesPerFile, maxTotalBytes: request.maxTotalBytes, accepted });
      if (!accepted) return { ok: false, kind: "host_key_rejected", fingerprint: presented, detail: "rejected" };
      return { ok: true, files: files(request.paths), fingerprint: presented, durationMs: 12 };
    },
  };
  return { transport, requests };
};

{
  const { deps, verifications } = depsFor(rowFor());
  const { transport, requests } = transportFor((paths) =>
    paths.map((path) =>
      path.endsWith("wp-content/debug.log")
        ? { path, status: "read", bytesRead: SAMPLE.length, size: 900_000, truncated: true, text: SAMPLE }
        : path.endsWith("wp-admin/error_log")
        ? { path, status: "not_regular" }
        : { path, status: "missing" },
    ),
  );

  const result = await readWordPressErrorLog(deps as never, transport as never, { projectId: "p1" });

  check("a pinned, bounded read succeeds", result.ok === true);
  check("every requested path stays under the WordPress root", requests[0]?.paths.every((path) => path.startsWith(`${ROOT}/`)) === true);
  check("the transport is given the byte budgets", requests[0]?.maxBytesPerFile === LOG_MAX_BYTES_PER_FILE && requests[0]?.maxTotalBytes === LOG_MAX_TOTAL_BYTES);
  check("a real read marks the SSH access verified", verifications.some(([type, state]) => type === "ssh" && state === "verified"));

  if (result.ok) {
    const serialized = JSON.stringify(result.data);
    check("no raw secret is persisted as evidence", !serialized.includes("sk_live_topsecrettoken") && !serialized.includes("hunter2correcthorse"));
    check("no credential material is persisted", !serialized.includes("PRIVATE KEY"));
    check("no host or username is persisted", !serialized.includes("example.com") && !serialized.includes("deploy"));
    check("absolute server paths are not persisted as sources", (result.data.selectedSources as string[]).every((s) => !s.startsWith("/")));
    check("a non-regular file was refused, not read", (result.data.nonRegularSkipped as string[]).includes("wp-admin/error_log"));
    check("truncation is reported honestly", result.data.truncated === true);
    check("evidence records the read as read-only", result.data.readOnly === true);
    check("the repeated component is surfaced", (result.data.likelyWordPressComponents as Array<{ name: string }>)[0]?.name === "checkout-x");
    check("the summary points at evidence, not a proven cause", /checkout-x/.test(result.summary) && !/root cause/i.test(result.summary));

    const evidence = { id: "e1", toolId: "wordpress.read_error_log", summary: result.summary, data: result.data } as never;
    const lines = describeErrorLog(evidence);
    check("the conversation gets a plain-English reading", lines.some((line: string) => /error log/i.test(line)));
    check("the conversation never receives a raw secret", !lines.join(" ").includes("sk_live"));
    const finding = findingFromEvidence(evidence);
    check("a repeated fatal pattern earns one bounded finding", finding !== null && /repeatedly references/.test(finding.summary));
    check("the finding does not claim proof", finding !== null && !/definitely|root cause is/i.test(finding.summary));
  }
}

{
  const { deps } = depsFor(rowFor());
  const { transport } = transportFor((paths) => paths.map((path) => ({ path, status: "missing" })));
  const result = await readWordPressErrorLog(deps as never, transport as never, { projectId: "p1" });
  check("no log present is a truthful empty result, not an error", result.ok === true);
  if (result.ok) {
    check("the empty result says so plainly", /none are present/.test(result.summary));
    check("no finding is invented from an empty read", findingFromEvidence({ id: "e", toolId: "wordpress.read_error_log", summary: result.summary, data: result.data } as never) === null);
  }
}

{
  const { deps, verifications } = depsFor(rowFor({ host_fingerprint: FP_B }));
  const { transport, requests } = transportFor((paths) => paths.map((path) => ({ path, status: "missing" })));
  const result = await readWordPressErrorLog(deps as never, transport as never, { projectId: "p1" });
  check("a host fingerprint mismatch blocks the read", result.ok === false && result.code === "host_key_rejected");
  check("the transport was told to refuse the key", requests[0]?.accepted === false);
  check("a blocked read never claims verification", verifications.length === 0);
}

{
  const { deps, verifications } = depsFor(rowFor());
  const transport = {
    readTails: async () => ({ ok: false, kind: "auth_failed", fingerprint: FP_A, detail: "deploy@example.com: Permission denied (publickey)" }),
  };
  const result = await readWordPressErrorLog(deps as never, transport as never, { projectId: "p1" });
  check("an auth failure fails closed", result.ok === false && result.code === "auth_failed");
  check("an auth failure leaks no server or provider detail", result.ok === false && !result.summary.includes("example.com") && !result.summary.includes("publickey"));
  check("an auth failure marks the access rejected through the server path", verifications.some(([type, state]) => type === "ssh" && state === "rejected"));
}

{
  const { deps } = depsFor(rowFor({ config: { host: "example.com", port: 22, wpBinary: "wp" } }));
  const { transport } = transportFor((paths) => paths.map((path) => ({ path, status: "missing" })));
  const result = await readWordPressErrorLog(deps as never, transport as never, { projectId: "p1" });
  check("no recorded WordPress folder fails closed rather than guessing", result.ok === false && result.code === "capability_unavailable");
}

{
  const { deps } = depsFor(null);
  const { transport } = transportFor((paths) => paths.map((path) => ({ path, status: "missing" })));
  const result = await readWordPressErrorLog(deps as never, transport as never, { projectId: "p1" });
  check("a project with no stored SSH access cannot read logs", result.ok === false);
}

// --- reasoner discipline -----------------------------------------------------

console.log("\nreasoner discipline");

const { deterministicReasoner } = await import("../src/agent-core/reasoner.ts");

const contextFor = (taskType: string, capabilities: string[]) => ({
  project: { id: "p1", name: "Site", url: "https://example.com" },
  run: { id: "run-1", taskType },
  environment: { primaryUrl: "https://example.com" },
  capabilities,
  evidence: [
    { id: "e1", toolId: "public_http.inspect_site", summary: "ok", data: { status: 200, wordpressSignals: true } },
    { id: "e2", toolId: "wordpress.inspect_public_surface", summary: "ok", data: { restApiAvailable: true } },
    { id: "e3", toolId: "wordpress.read_health", summary: "ok", data: {} },
    { id: "e4", toolId: "wordpress.run_wp_cli_readonly", summary: "ok", data: {} },
  ],
  findings: [],
});

const plans = async (taskType: string, capabilities: string[]) => {
  const plan = await deterministicReasoner.plan(contextFor(taskType, capabilities) as never);
  return plan.actions.some((action: { toolId: string }) => action.toolId === "wordpress.read_error_log");
};

check("a broken site with SSH plans the error-log read", await plans("broken_site", ["ssh"]));
check("a plugin conflict with SSH plans the error-log read", await plans("plugin_theme_conflict", ["ssh"]));
check("a content task does not plan the error-log read", !(await plans("content", ["ssh"])));
check("no SSH means no error-log read is planned", !(await plans("broken_site", ["wordpress_admin"])));
check("an already-read log is not read again", await (async () => {
  const context = contextFor("broken_site", ["ssh"]) as Record<string, unknown>;
  (context.evidence as unknown[]).push({ id: "e5", toolId: "wordpress.read_error_log", summary: "read", data: {} });
  const plan = await deterministicReasoner.plan(context as never);
  return !plan.actions.some((action: { toolId: string }) => action.toolId === "wordpress.read_error_log");
})());

// --- result ------------------------------------------------------------------

console.log("");
if (failures.length > 0) {
  console.log(`FAILED (${failures.length})`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("error-log boundary checks passed");
