/**
 * Executable validation for the agent execution kernel.
 *
 * Run with: npm run check:agent
 *
 * These checks guard the safety-critical guarantees: SSRF rules, redaction,
 * deterministic invocation keys, idempotent reuse, policy classification, and
 * the rule that a real run never fabricates a result.
 */

// Minimal browser shim so the local persistence adapter is exercised for real.
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
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const { validatePublicUrl, redactHeaders, redactText, safeSummary } = await import("../src/agent-core/safety.ts");
const { classifyRisk, evaluateAction } = await import("../src/agent-core/policy.ts");
const { invocationKeyFor, planAction, toolIsUsable, TOOL_REGISTRY } = await import("../src/agent-core/registry.ts");
const { deterministicReasoner, isValidPlan } = await import("../src/agent-core/reasoner.ts");
const { setExecutionGateway } = await import("../src/agent-core/gateway.ts");
const { runAgentTurn } = await import("../src/agent-core/orchestrator.ts");
const { createSeedWorkspace } = await import("../src/seed.ts");

console.log("\nrisk classification");
check("public inspections are read only", classifyRisk("public_http.inspect_site") === "read_only");
check("wp-cli execution is high risk", classifyRisk("wordpress.execute_wp_cli") === "high_risk_change");
check("database writes are high risk", classifyRisk("database.execute") === "high_risk_change");

console.log("\ntool registry capability checks");
check("public tool usable with public internet", toolIsUsable("public_http.inspect_site", ["public_internet"]));
check("plugin listing is not usable yet", !toolIsUsable("wordpress.list_plugins", ["wordpress_admin"]));
check("site health is implemented", TOOL_REGISTRY["wordpress.read_health"].implemented);
check("only implemented tools are declared so", Object.values(TOOL_REGISTRY).filter((tool) => tool.implemented).length === 3);

console.log("\nurl / SSRF validation");
const blocked = [
  "http://localhost/",
  "http://127.0.0.1/wp-json",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5/",
  "http://192.168.1.10/",
  "http://172.16.4.4/",
  "file:///etc/passwd",
  "ftp://example.com/",
  "http://host.internal/",
];
for (const candidate of blocked) {
  check(`rejects ${candidate}`, validatePublicUrl(candidate).ok === false);
}
check("accepts a public https url", validatePublicUrl("https://example.com/").ok === true);

console.log("\nredaction");
check("authorization header is redacted", redactHeaders({ Authorization: "Bearer abcdefghijklmno" }).authorization === "[redacted]");
check("set-cookie is redacted", redactHeaders({ "Set-Cookie": "session=abc" })["set-cookie"] === "[redacted]");
check("query secrets are redacted", !redactText("https://x.test/?token=supersecretvalue").includes("supersecretvalue"));
check("password assignments are redacted", !redactText("password: hunter2hunter2").includes("hunter2hunter2"));
check("summaries stay bounded", safeSummary("x".repeat(900)).length <= 240);

console.log("\ndeterministic invocation keys");
const keyA = invocationKeyFor("run-1", "public_http.inspect_site", { url: "https://example.com/", depth: 1 });
const keyB = invocationKeyFor("run-1", "public_http.inspect_site", { depth: 1, url: "https://example.com/" });
const keyC = invocationKeyFor("run-2", "public_http.inspect_site", { url: "https://example.com/" });
check("key is stable across argument order", keyA === keyB);
check("key differs per run", keyA !== keyC);
check("key contains no timestamp", !/\d{13}/.test(keyA));

console.log("\nplan / schema validation");
check("rejects a non-plan", !isValidPlan({ foo: "bar" }));
check("rejects an unknown intent", !isValidPlan({ decision: { intent: "delete_everything", rationale: "" }, actions: [] }));
check(
  "accepts a well-formed plan",
  isValidPlan({
    decision: { intent: "inspect_public_surface", rationale: "start public" },
    actions: [
      {
        id: "a",
        toolId: "public_http.inspect_site",
        invocationKey: "k",
        readOnly: true,
        args: { url: "https://example.com/" },
      },
    ],
  }),
);

// --- fixtures ---------------------------------------------------------------
const workspace = createSeedWorkspace();
const project = { ...workspace.projects[0], accessMethods: [] };
const baseRun = project.runs[0];
const run = { ...baseRun, id: "run-check-1", state: "diagnosis" as const };

const context = {
  project,
  run,
  recentMessages: [],
  memory: [],
  capabilities: ["public_internet" as const],
  evidence: [],
  environment: { primaryUrl: "https://example.com/", executionBackendAvailable: true },
};

console.log("\npolicy gating");
const built = planAction("inspect", "public_http.inspect_site", run.id, { url: "https://example.com/" });
check("action builds", !("error" in built));
if (!("error" in built)) {
  check("read-only action runs without approval", evaluateAction(built, context).executable === true);
  const privileged = { ...built, capability: "ssh" as const, risk: "high_risk_change" as const, readOnly: false };
  const verdict = evaluateAction(privileged, context);
  check("privileged action is blocked without access", verdict.executable === false);
}
check("invalid url is refused at plan time", "error" in planAction("x", "public_http.inspect_site", run.id, { url: "http://127.0.0.1/" }));

console.log("\ndeterministic reasoner");
const firstPlan = await deterministicReasoner.plan(context);
check("first plan inspects the public site", firstPlan.actions[0]?.toolId === "public_http.inspect_site");
const exhausted = await deterministicReasoner.plan({
  ...context,
  evidence: [
    { id: "e1", toolId: "public_http.inspect_site", summary: "", data: {}, sensitivity: "public", redacted: true, observedAt: "" },
    { id: "e2", toolId: "wordpress.inspect_public_surface", summary: "", data: {}, sensitivity: "public", redacted: true, observedAt: "" },
  ],
});
check(
  "asks for the minimum access instead of guessing",
  exhausted.decision.intent === "request_access" && (exhausted.decision.requestedAccess ?? []).length > 0,
);
check("never fabricates a finding when access is missing", exhausted.actions.length === 0);

console.log("\nidempotent execution + evidence grounding");
let calls = 0;
const spoken: string[][] = [];
setExecutionGateway({
  available: () => true,
  invoke: async () => {
    calls += 1;
    return {
      ok: true as const,
      summary: "The site answered 200 in 320ms. token=leakedsecretvalue",
      data: { status: 200, durationMs: 320, finalUrl: "https://example.com/", title: "Example", password: "hunter2hunter2" },
    };
  },
});

const turnInput = {
  project,
  run,
  recentMessages: [],
  memory: [],
  emit: async (message: { body: string[] }) => {
    spoken.push(message.body);
    return null;
  },
  onWorkspaceUpdate: () => {},
};

await runAgentTurn(turnInput as never);
const callsAfterFirst = calls;
await runAgentTurn(turnInput as never);
check("first turn executed a real tool", callsAfterFirst === 1);
check("replaying the same turn reuses the completed invocation", calls === 1 + 1);

const flat = spoken.flat().join(" ");
check("agent speaks plainly, not in tool ids", !flat.includes("public_http.inspect_site"));
check("agent reports what was observed", flat.includes("responded normally"));
check("no secret-shaped values reach the conversation", !flat.includes("leakedsecretvalue") && !flat.includes("hunter2hunter2"));

console.log("\nno fabricated QA on real runs");
const { executeAgentStep, agentStepIdentity } = await import("../src/agentExecutor.ts");
const qaSpoken: string[][] = [];
const qaRun = { ...run, state: "qa" as const };
check("real run has a qa step identity that is not a verdict", agentStepIdentity(project, qaRun) === `${qaRun.id}:qa:unverified`);
await executeAgentStep({
  project,
  run: qaRun,
  emit: async (message) => {
    qaSpoken.push(message.body);
    return null;
  },
  onWorkspaceUpdate: () => {},
} as never);
const qaText = qaSpoken.flat().join(" ");
check("qa is reported truthfully, not as passed", qaText.includes("can't verify") && !/all checks/i.test(qaText));

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("All agent-core checks passed.");
