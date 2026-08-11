/**
 * Executable validation for the server-side reasoning boundary.
 *
 * Run with: npm run check:reasoner
 *
 * The claims asserted here: a model can only choose from a closed catalog, it
 * can never author a tool, command, argument or URL, it can never plan beyond
 * the access a run actually holds, it can never plan a change, nothing it
 * returns bypasses the registry, the digest it sees carries no secret, and an
 * unavailable or nonsense model never stalls a run.
 */

import { readFileSync } from "node:fs";

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const { REASON_STEPS, REASON_STEP_IDS, MAX_STEPS_PER_TURN, validateReasonPlan } = await import(
  "../supabase/functions/_shared/reasonCatalog.ts"
);
const { sanitizeDigest, parseModelJson, userPrompt, SYSTEM_PROMPT } = await import(
  "../supabase/functions/_shared/reasonPrompt.ts"
);
const { REASON_STEPS: CLIENT_STEPS, materializeServerPlan } = await import("../src/agent-core/reasonPlan.ts");
const { setExecutionGateway } = await import("../src/agent-core/gateway.ts");
const { serverModelReasoner, selectReasoner, deterministicReasoner, reasoningDigest } = await import(
  "../src/agent-core/reasoner.ts"
);
const { TOOL_REGISTRY } = await import("../src/agent-core/registry.ts");

const ALL = ["public_internet", "wordpress_admin", "ssh"];

console.log("\ncatalog is closed and mirrored");
check(
  "server and client catalogs describe the same steps",
  JSON.stringify(REASON_STEP_IDS.slice().sort()) === JSON.stringify(Object.keys(CLIENT_STEPS).sort()),
);
check(
  "every catalog step maps to a real, implemented, read-only tool",
  REASON_STEP_IDS.every((id) => {
    const tool = TOOL_REGISTRY[REASON_STEPS[id].toolId as keyof typeof TOOL_REGISTRY];
    return Boolean(tool) && tool.implemented && tool.readOnly;
  }),
);
check(
  "client and server agree on tool, capability and command for every step",
  REASON_STEP_IDS.every((id) => {
    const a = REASON_STEPS[id];
    const b = CLIENT_STEPS[id];
    return (
      b &&
      a.toolId === b.toolId &&
      a.capability === b.capability &&
      (a.commandId ?? null) === (b.commandId ?? null) &&
      a.serverResolvedTarget === b.serverResolvedTarget
    );
  }),
);

console.log("\nmodel answers are validated, never trusted");
const good = validateReasonPlan(
  { intent: "inspect_public_surface", rationale: "Start from outside.", steps: [{ id: "inspect-site" }] },
  ALL,
);
check("a valid catalog plan is accepted", good.ok && good.plan.steps[0].id === "inspect-site");
check(
  "an invented tool is rejected",
  !validateReasonPlan(
    { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "filesystem.write" }] },
    ALL,
  ).ok,
);
check(
  "an invented intent is rejected",
  !validateReasonPlan({ intent: "delete_everything", rationale: "x", steps: [] }, ALL).ok,
);
check(
  "a step beyond available access is rejected",
  !validateReasonPlan({ intent: "inspect_public_surface", rationale: "x", steps: [{ id: "list-plugins" }] }, [
    "public_internet",
  ]).ok,
);
check(
  "requesting access the run already holds is dropped",
  (() => {
    const result = validateReasonPlan(
      { intent: "request_access", rationale: "x", requestedAccess: ["wordpress_admin", "carrier_pigeon"], steps: [] },
      ALL,
    );
    return result.ok && result.plan.requestedAccess.length === 0;
  })(),
);
check(
  "asking for access while also acting is rejected",
  !validateReasonPlan(
    { intent: "request_access", rationale: "x", requestedAccess: ["ssh"], steps: [{ id: "inspect-site" }] },
    ALL,
  ).ok,
);
check(
  "a turn is bounded to a small number of steps",
  (() => {
    const result = validateReasonPlan(
      {
        intent: "inspect_public_surface",
        rationale: "x",
        steps: REASON_STEP_IDS.map((id) => ({ id })),
      },
      ALL,
    );
    return result.ok && result.plan.steps.length <= MAX_STEPS_PER_TURN;
  })(),
);
check(
  "duplicate steps collapse to one",
  (() => {
    const result = validateReasonPlan(
      { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "inspect-site" }, { id: "inspect-site" }] },
      ALL,
    );
    return result.ok && result.plan.steps.length === 1;
  })(),
);
check("a non-object answer is rejected", !validateReasonPlan("do everything", ALL).ok);

console.log("\nprose stays bounded and human");
const longPlan = validateReasonPlan(
  { intent: "report_findings", rationale: "r".repeat(2000), message: ["m".repeat(2000)] },
  ALL,
);
check(
  "rationale and message lines are bounded",
  longPlan.ok && longPlan.plan.rationale.length <= 400 && longPlan.plan.message[0].length <= 400,
);

console.log("\nthe browser rebuilds the real action from the registry");
const materialized = materializeServerPlan(
  {
    intent: "inspect_public_surface",
    rationale: "Look from outside first.",
    steps: [{ id: "inspect-site", purpose: "Check the front page." }],
  },
  { runId: "run-1", url: "https://example.com/", capabilities: ALL },
);
check("a catalog plan materializes into a real action", materialized?.actions.length === 1);
check(
  "the action's tool and arguments come from the registry, not the model",
  materialized?.actions[0].toolId === "public_http.inspect_site" &&
    Object.keys(materialized.actions[0].args).join() === "url",
);
check("materialized actions carry a deterministic invocation key", Boolean(materialized?.actions[0].invocationKey));
check("materialized plans are read-only", materialized?.riskSummary === "read_only");

const smuggled = materializeServerPlan(
  {
    intent: "inspect_public_surface",
    rationale: "x",
    steps: [{ id: "wp-cli-core-version", purpose: "p" }],
  },
  { runId: "run-1", url: "https://example.com/", capabilities: ALL },
);
check(
  "a WP-CLI step can only carry its fixed catalog command",
  smuggled?.actions[0].args.commandId === "core.version" && Object.keys(smuggled.actions[0].args).join() === "commandId",
);
check(
  "a model-supplied command is impossible to inject",
  materializeServerPlan(
    { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "wp-cli-core-version", commandId: "plugin delete" } as never] },
    { runId: "run-1", url: "https://example.com/", capabilities: ALL },
  )?.actions[0].args.commandId === "core.version",
);
check(
  "a model-supplied url is ignored in favour of the project's own address",
  materializeServerPlan(
    { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "inspect-site", url: "http://169.254.169.254/" } as never] },
    { runId: "run-1", url: "https://example.com/", capabilities: ALL },
  )?.actions[0].args.url === "https://example.com/",
);
check(
  "a step needing access the run lacks never materializes",
  materializeServerPlan(
    { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "read-error-log" }] },
    { runId: "run-1", url: "https://example.com/", capabilities: ["public_internet"] },
  ) === null,
);
check(
  "an unknown step never materializes",
  materializeServerPlan(
    { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "rm-rf" }] },
    { runId: "run-1", url: "https://example.com/", capabilities: ALL },
  ) === null,
);
check(
  "a public step without a known site address never materializes",
  materializeServerPlan(
    { intent: "inspect_public_surface", rationale: "x", steps: [{ id: "inspect-site" }] },
    { runId: "run-1", url: null, capabilities: ALL },
  ) === null,
);

console.log("\nthe digest carries nothing sensitive");
const digest = sanitizeDigest({
  taskType: "broken_site",
  taskTitle: "Checkout is down",
  siteKnown: true,
  capabilities: ["public_internet", "ssh", "root_shell"],
  evidence: [{ toolId: "public_http.inspect_site", summary: "answered 500 token=abcdefghijklmnopqrstuvwxyz012345" }],
  messages: [{ role: "user", text: "the password is hunter2hunter2hunter2hunter2hunter2" }],
  memory: ["x".repeat(900)],
});
check("unknown capabilities are dropped from the digest", !digest.capabilities.includes("root_shell"));
check("long secret-like strings are redacted from evidence", digest.evidence[0].summary.includes("[redacted]"));
check("digest memory lines are bounded", digest.memory[0].length <= 200);
check(
  "a pasted credential value never reaches the prompt",
  !userPrompt(digest).includes("hunter2") && digest.messages[0].text.includes("[redacted]"),
);
check("the system prompt forbids inventing tools", /Never invent a tool/.test(SYSTEM_PROMPT));
check(
  "fenced JSON answers are parsed",
  (parseModelJson('```json\n{"intent":"no_action"}\n```') as { intent: string })?.intent === "no_action",
);
check("unparseable answers return null", parseModelJson("I refuse.") === null);

console.log("\nreasoning never stalls a run");
const context = {
  project: { id: "p1", environments: [], accessMethods: [], primaryDomain: "example.com" },
  run: { id: "run-1", taskType: "broken_site", title: "Checkout is down" },
  recentMessages: [],
  memory: [],
  capabilities: ["public_internet"],
  verifiedCapabilities: [],
  evidence: [],
  environment: { primaryUrl: "https://example.com/", executionBackendAvailable: true },
} as never;

check("the digest built from context is JSON-safe", typeof JSON.stringify(reasoningDigest(context)) === "string");

setExecutionGateway({
  available: () => true,
  projectCapabilities: async () => ({ stored: [], verified: [] }),
  invoke: async () => ({ ok: false as const, code: "not_implemented" as const, summary: "", retryable: false }),
  reason: async () => null,
});
check("an unavailable model yields no plan of its own", (await serverModelReasoner.plan(context)) === null);
const fellBack = await selectReasoner().plan(context);
const deterministic = await deterministicReasoner.plan(context);
check(
  "the deterministic operator takes the turn instead",
  Boolean(fellBack) && fellBack?.actions[0]?.toolId === deterministic?.actions[0]?.toolId,
);

setExecutionGateway({
  available: () => true,
  projectCapabilities: async () => ({ stored: [], verified: [] }),
  invoke: async () => ({ ok: false as const, code: "not_implemented" as const, summary: "", retryable: false }),
  reason: async () => ({ intent: "inspect_public_surface", rationale: "x", steps: [{ id: "filesystem.write" }] }),
});
check("a model answer outside the catalog is refused", (await serverModelReasoner.plan(context)) === null);
check("and the run still progresses deterministically", Boolean(await selectReasoner().plan(context)));

setExecutionGateway({
  available: () => true,
  projectCapabilities: async () => ({ stored: [], verified: [] }),
  invoke: async () => ({ ok: false as const, code: "not_implemented" as const, summary: "", retryable: false }),
  reason: async () => {
    throw new Error("gateway exploded");
  },
});
check("a thrown reasoning error never stalls the run", Boolean(await selectReasoner().plan(context)));

setExecutionGateway({
  available: () => true,
  projectCapabilities: async () => ({ stored: [], verified: [] }),
  invoke: async () => ({ ok: false as const, code: "not_implemented" as const, summary: "", retryable: false }),
  reason: async () => ({
    intent: "report_findings",
    rationale: "The site answers normally from outside.",
    message: ["The site is responding normally from outside."],
    steps: [],
  }),
});
const spoken = await serverModelReasoner.plan(context);
check("a real model plan is used when it is valid", spoken?.decision.intent === "report_findings");
check("its actions are still empty when it plans none", spoken?.actions.length === 0);

console.log("\nmodel choice is closed and cannot widen authority");
const { REASON_MODELS, DEFAULT_REASON_MODEL_ID, resolveReasonModel } = await import(
  "../supabase/functions/_shared/reasonModels.ts"
);
const { REASON_MODEL_OPTIONS, DEFAULT_REASON_MODEL_ID: CLIENT_DEFAULT, readReasonModelId } = await import(
  "../src/agent-core/reasonModels.ts"
);
const { readModelText } = await import("../supabase/functions/_shared/reasonModels.ts");

check(
  "the browser list mirrors the server list exactly",
  JSON.stringify(REASON_MODELS.map((m) => m.id)) === JSON.stringify(REASON_MODEL_OPTIONS.map((m) => m.id)),
);
check("both sides agree on the default model", DEFAULT_REASON_MODEL_ID === CLIENT_DEFAULT);
check("the default is Claude Sonnet", DEFAULT_REASON_MODEL_ID === "claude-sonnet");
check("an unknown model id falls back to the default", resolveReasonModel("evil/model").id === DEFAULT_REASON_MODEL_ID);
check("a non-string model id falls back to the default", resolveReasonModel({ id: "x" }).id === DEFAULT_REASON_MODEL_ID);
check("a browser with no stored preference uses the default", readReasonModelId() === DEFAULT_REASON_MODEL_ID);
check(
  "every model names a real provider and its own credential",
  REASON_MODELS.every(
    (m) =>
      (m.provider === "anthropic" && m.secretName === "ANTHROPIC_API_KEY") ||
      (m.provider === "lovable_gateway" && m.secretName === "LOVABLE_API_KEY"),
  ),
);
check(
  "no model carries an endpoint, header or prompt of its own",
  REASON_MODELS.every((m) => Object.keys(m).join(",") === "id,label,provider,providerModel,note,secretName"),
);
check(
  "Claude answers are read from Anthropic's envelope",
  readModelText("anthropic", { content: [{ type: "text", text: '{"intent":"no_action"}' }] }) ===
    '{"intent":"no_action"}',
);
check(
  "gateway answers are read from the chat envelope",
  readModelText("lovable_gateway", { choices: [{ message: { content: "hi" } }] }) === "hi",
);
check("a malformed provider envelope yields no text", readModelText("anthropic", { content: "nope" }) === "");
check(
  "a Claude answer outside the catalog is still rejected",
  validateReasonPlan(parseModelJson('{"intent":"inspect_public_surface","steps":[{"id":"delete-plugin"}]}'), ALL).ok ===
    false,
);

// Provider auth headers: Anthropic uses x-api-key, the Lovable gateway uses its
// own header. A Bearer token on the gateway path is a silent auth failure.
{
  const fn = readFileSync("supabase/functions/agent-reason/index.ts", "utf8");
  check("gateway call authenticates with the Lovable-API-Key header", fn.includes('"Lovable-API-Key": apiKey'));
  check("gateway call never uses a Bearer token", !/Authorization:\s*`Bearer/.test(fn));
  check("anthropic call authenticates with x-api-key", fn.includes('"x-api-key": apiKey'));
  check("anthropic call pins an API version", fn.includes('"anthropic-version"'));
}

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all reasoning boundary checks passed");
