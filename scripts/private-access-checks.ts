/**
 * Executable validation for the private WordPress execution path.
 *
 * Run with: npm run check:private
 *
 * These checks guard the guarantees that matter once a real credential exists:
 * a private tool cannot run for an unproven caller, a secret cannot be read
 * back, a missing encryption key never degrades into plaintext, and an
 * authenticated claim is only made when WordPress actually answered.
 */

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
};

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const { authorizeProject, bearerToken } = await import("../supabase/functions/_shared/authz.ts");
const { openSecret, parseEncryptionKey, sealSecret } = await import("../supabase/functions/_shared/crypto.ts");
const { resolvableCapabilities, resolveCredential, storeCredential } = await import(
  "../supabase/functions/_shared/secretStore.ts"
);
const { authenticatedGet, basicAuthHeader, normalizeHealthTest, normalizePlugins } = await import(
  "../supabase/functions/_shared/wordpress.ts"
);
const { describeHealth, describePlugins } = await import("../src/agent-core/evidence.ts");
const { deterministicReasoner } = await import("../src/agent-core/reasoner.ts");
const { TOOL_REGISTRY } = await import("../src/agent-core/registry.ts");

const APP_PASSWORD = "abcd efgh ijkl mnop qrst uvwx";
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

// --- caller authorization ---------------------------------------------------

const deps = (overrides: Record<string, unknown> = {}) => ({
  verifyToken: async (token: string) =>
    token === "good" ? { userId: "u1", email: "owner@example.com" } : null,
  loadProject: async (id: string) =>
    id === "p1" ? { id: "p1", organizationId: "org-1", primaryDomain: "example.com" } : id === "p2"
      ? { id: "p2", organizationId: "org-2", primaryDomain: "other.com" }
      : null,
  loadMembership: async () => ({ organizationId: "org-1" }),
  loadEnvironment: async () => ({ id: "env-1", primaryUrl: "https://example.com" }),
  ...overrides,
});

console.log("\ncaller authorization");
check("no header is unauthorized", (await authorizeProject(null, "p1", deps() as never)).ok === false);
check("bearer parsing rejects a bare token", bearerToken("abc") === null);
const anon = await authorizeProject("Bearer bad", "p1", deps() as never);
check("invalid token is unauthorized", !anon.ok && anon.code === "unauthorized");
const other = await authorizeProject("Bearer good", "p2", deps() as never);
check("caller cannot reach another organization's project", !other.ok && other.code === "forbidden");
const missing = await authorizeProject("Bearer good", "nope", deps() as never);
check("unknown project is forbidden", !missing.ok && missing.code === "forbidden");
const broken = await authorizeProject(
  "Bearer good",
  "p1",
  deps({ loadProject: async () => { throw new Error("db down"); } }) as never,
);
check("unprovable context fails closed", !broken.ok && broken.code === "execution_context_unavailable");
const good = await authorizeProject("Bearer good", "p1", deps() as never);
check("member is authorized for their own project", good.ok === true);
check("site address is resolved server-side", good.ok && good.project.canonicalUrl === "https://example.com");

// --- secret store -----------------------------------------------------------

console.log("\nsecret store");
const rows = new Map<string, Record<string, unknown>>();
const storeDeps = (key: string | undefined) => ({
  encryptionKey: key,
  saveRow: async (row: Record<string, unknown>) => void rows.set(`${row.project_id}:${row.access_type}`, row),
  loadRow: async (projectId: string, accessType: string) =>
    (rows.get(`${projectId}:${accessType}`) as never) ?? null,
});

const noKey = await storeCredential(storeDeps(undefined) as never, {
  projectId: "p1",
  accessType: "wordpress_admin",
  provider: "wordpress_application_password",
  username: "admin",
  secret: APP_PASSWORD,
});
check("missing key returns secret_store_unavailable", !noKey.ok && noKey.code === "secret_store_unavailable");
check("missing key stores nothing at all", rows.size === 0);

const stored = await storeCredential(storeDeps(KEY) as never, {
  projectId: "p1",
  accessType: "wordpress_admin",
  provider: "wordpress_application_password",
  username: "admin",
  secret: APP_PASSWORD,
});
check("credential is stored with a key present", stored.ok === true);
const row = rows.get("p1:wordpress_admin") as Record<string, string>;
check("row holds ciphertext, never plaintext", !JSON.stringify(row).includes("abcd") && row.ciphertext.length > 0);
check("row records the algorithm", row.algorithm === "AES-256-GCM" && row.iv.length > 0);

const resolved = await resolveCredential(storeDeps(KEY) as never, "p1", "wordpress_admin");
check("round trip returns the original secret server-side", resolved.ok && resolved.credential.applicationPassword === APP_PASSWORD);
const wrongProject = await resolveCredential(storeDeps(KEY) as never, "p2", "wordpress_admin");
check("another project cannot resolve this secret", !wrongProject.ok && wrongProject.code === "capability_unavailable");
const wrongKey = await resolveCredential(
  storeDeps(Buffer.from(new Uint8Array(32).fill(9)).toString("base64")) as never,
  "p1",
  "wordpress_admin",
);
check("a wrong key never yields plaintext", !wrongKey.ok && wrongKey.code === "secret_store_unavailable");
check("tampered ciphertext is rejected", (await openSecret(
  { ...(await sealSecret("x", (await parseEncryptionKey(KEY)).ok ? ((await parseEncryptionKey(KEY)) as { key: Uint8Array }).key : new Uint8Array(32))), ciphertext: "AAAA" },
  ((await parseEncryptionKey(KEY)) as { key: Uint8Array }).key,
)).ok === false);

console.log("\nserver-confirmed capabilities");
check(
  "capability is confirmed only where a secret resolves",
  JSON.stringify(await resolvableCapabilities(storeDeps(KEY) as never, "p1", ["wordpress_admin", "ssh"])) ===
    JSON.stringify(["wordpress_admin"]),
);
check(
  "no capability is confirmed without the encryption key",
  (await resolvableCapabilities(storeDeps(undefined) as never, "p1", ["wordpress_admin"])).length === 0,
);

// --- credential handling over the wire --------------------------------------

console.log("\ncredential handling in transit");
const credential = { username: "admin", applicationPassword: "secretpass" };
check("basic auth header is built correctly", basicAuthHeader(credential) === `Basic ${btoa("admin:secretpass")}`);

const responses = (script: Array<{ status: number; headers?: Record<string, string>; body?: string }>) => {
  const seen: Array<Record<string, string>> = [];
  let index = 0;
  const impl = async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push({ ...init.headers });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    return new Response(next.body ?? "", { status: next.status, headers: next.headers });
  };
  return { impl: impl as unknown as typeof fetch, seen };
};

const crossOrigin = responses([
  { status: 302, headers: { location: "https://evil.test/steal" } },
  { status: 200, headers: { "content-type": "application/json" }, body: "[]" },
]);
const crossResult = await authenticatedGet("https://example.com", "/wp-json/wp/v2/plugins", credential, crossOrigin.impl);
check(
  "credential is stripped on a cross-origin redirect",
  crossResult.ok && crossResult.credentialsSurvived === false && !("authorization" in crossOrigin.seen[1]),
);

const sameOrigin = responses([
  { status: 301, headers: { location: "https://example.com/wp-json/wp/v2/plugins/" } },
  { status: 200, headers: { "content-type": "application/json" }, body: "[]" },
]);
const sameResult = await authenticatedGet("https://example.com", "/wp-json/wp/v2/plugins", credential, sameOrigin.impl);
check(
  "credential survives a same-origin redirect",
  sameResult.ok && sameResult.credentialsSurvived === true && sameOrigin.seen[1].authorization === basicAuthHeader(credential),
);

const privateTarget = await authenticatedGet("http://127.0.0.1", "/wp-json/wp/v2/plugins", credential, sameOrigin.impl);
check("a private address is never called with a credential", !privateTarget.ok && privateTarget.kind === "unsafe");

console.log("\ntruthful outcomes");
for (const [status, kind] of [[401, "unauthorized"], [403, "forbidden"], [404, "endpoint_unavailable"]] as const) {
  const outcome = await authenticatedGet(
    "https://example.com",
    "/wp-json/wp/v2/plugins",
    credential,
    responses([{ status }]).impl,
  );
  check(`${status} maps to ${kind}`, !outcome.ok && outcome.kind === kind);
}
const networkFail = await authenticatedGet(
  "https://example.com",
  "/wp-json/wp/v2/plugins",
  credential,
  (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch,
);
check("a transport failure maps to network", !networkFail.ok && networkFail.kind === "network");

// --- normalization -----------------------------------------------------------

console.log("\nplugin inventory normalization");
const inventory = normalizePlugins([
  { plugin: "akismet/akismet", name: "Akismet <b>Anti-Spam</b>", status: "active", version: "5.3", author: "Automattic", update: "1.0" },
  { plugin: "hello/hello", name: "Hello Dolly", status: "inactive", version: "1.7.2" },
]);
check("counts are read, not guessed", inventory?.total === 2 && inventory.active === 1 && inventory.inactive === 1);
check("markup is stripped from plugin names", inventory?.plugins[0].name === "Akismet Anti-Spam");
check("update state is only set when WordPress said so", inventory?.plugins[0].updateAvailable === true && inventory.plugins[1].updateAvailable === null);
check("a non-list payload is refused", normalizePlugins({ error: "nope" }) === null);
const big = normalizePlugins(Array.from({ length: 250 }, (_, i) => ({ plugin: `p${i}`, name: `P${i}`, status: "active" })));
check("the list is bounded", big?.plugins.length === 200 && big.truncated === true);
check("an empty health payload proves nothing", normalizeHealthTest("https-status", {}) === null);

console.log("\nwhat the agent is allowed to say");
const pluginLines = describePlugins({
  id: "e",
  toolId: "wordpress.list_plugins",
  summary: "",
  data: { total: 2, active: 1, inactive: 1, plugins: inventory?.plugins ?? [] },
  sensitivity: "restricted",
  redacted: true,
  observedAt: "",
} as never).join(" ");
check("plugin counts are reported", pluginLines.includes("2 plugins"));
check(
  "no plugin is called outdated, vulnerable or abandoned",
  !/outdated|vulnerable|abandoned|conflict/i.test(pluginLines),
);

const claimed = describeHealth({
  data: { authenticatedHealthAvailable: true, authenticatedChecksRead: [] },
} as never).join(" ");
check("authenticated health is not claimed with zero checks read", !claimed.includes("I'm in"));
const real = describeHealth({
  data: { authenticatedHealthAvailable: true, authenticatedChecksRead: [{ id: "https-status", label: "HTTPS", status: "good" }] },
} as never).join(" ");
check("authenticated health is claimed when a check was read", real.includes("I'm in"));
const rejected = describeHealth({ data: { authenticatedHealthCode: "unauthorized" } } as never).join(" ");
check("a rejected credential is reported honestly", rejected.includes("rejected"));

// --- reasoner ----------------------------------------------------------------

console.log("\ndeterministic reasoner sequencing");
const { createSeedWorkspace } = await import("../src/seed.ts");
const workspace = createSeedWorkspace();
const project = { ...workspace.projects[0], accessMethods: [] };
const run = { ...project.runs[0], id: "run-private-1", state: "diagnosis" as const, taskType: "performance" as const };
const evidence = (toolId: string, data: Record<string, unknown>) => ({
  id: toolId,
  toolId,
  summary: "",
  data,
  sensitivity: "public" as const,
  redacted: true,
  observedAt: "",
});

const baseContext = {
  project,
  run,
  recentMessages: [],
  memory: [],
  evidence: [
    evidence("public_http.inspect_site", { wordpressSignals: true }),
    evidence("wordpress.inspect_public_surface", { restApiAvailable: true }),
    evidence("wordpress.read_health", { credentialsRequired: true }),
  ],
  environment: { primaryUrl: "https://example.com/", executionBackendAvailable: true },
};

const withoutAccess = await deterministicReasoner.plan({ ...baseContext, capabilities: ["public_internet"] } as never);
check("asks for WordPress admin only", JSON.stringify(withoutAccess.decision.requestedAccess) === JSON.stringify(["wordpress_admin"]));
check("does not preemptively ask for SFTP or SSH", !JSON.stringify(withoutAccess.decision.requestedAccess).includes("ssh"));
check("fabricates no plugin finding without access", withoutAccess.actions.length === 0);

const withAccess = await deterministicReasoner.plan({
  ...baseContext,
  capabilities: ["public_internet", "wordpress_admin"],
} as never);
const plannedTools = withAccess.actions.map((action: { toolId: string }) => action.toolId);
check("private reads are planned once admin access is confirmed", plannedTools.includes("wordpress.list_plugins"));
check("plugin listing carries no client-supplied url", JSON.stringify(withAccess.actions.at(-1)?.args) === "{}");
check("every planned action stays read-only", withAccess.actions.every((action: { readOnly: boolean }) => action.readOnly));

console.log("\nno mutation surface");
check(
  "no write tool is implemented",
  Object.values(TOOL_REGISTRY).every((tool) => !tool.implemented || tool.readOnly),
);

// --- browser retains nothing ---------------------------------------------------

console.log("\nbrowser retains no secret");
const persisted = JSON.stringify([...store.entries()]);
check("nothing secret-shaped is in local storage", !persisted.includes(APP_PASSWORD) && !persisted.includes("secretpass"));

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("All private-access checks passed.");
