import "./hermetic-env.ts";

/**
 * Executable validation for the agent system-thinking layer.
 *
 * Run with: npm run check:system-thinking
 *
 * These checks guard the eight disciplines that separate an agent that acts
 * from an agent that thinks: a visible plan, read-before-write, per-step
 * verification, bounded parallel investigation, a failure ladder, diff-first
 * approvals, standing constraints, and an honest close-out.
 */

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const plan = await import("../src/agent-core/plan.ts");
const { checkReadBeforeWrite, writeTargetFor, readLedger } = await import("../src/agent-core/precondition.ts");
const { verifyStep } = await import("../src/agent-core/verify.ts");
const { classifyFailure, escalate, routeIsExhausted } = await import("../src/agent-core/failure.ts");
const { detectConstraints, constraintAlreadyStored, constraintsTouching } = await import(
  "../src/agent-core/constraints.ts"
);
const { evaluateAction } = await import("../src/agent-core/policy.ts");
const { MAX_PARALLEL_INVESTIGATIONS, MAX_AGENT_ITERATIONS } = await import("../src/agent-core/budgets.ts");
const { planAction } = await import("../src/agent-core/registry.ts");
const { createSeedWorkspace } = await import("../src/seed.ts");

const workspace = createSeedWorkspace();
const seedProject = workspace.projects[0];
const run = { ...seedProject.runs[0], id: "run-st-1", state: "diagnosis" as const };

const evidenceOf = (toolId: string, data: Record<string, unknown>) => ({
  id: `ev-${toolId}-${JSON.stringify(data).length}`,
  toolId: toolId as never,
  summary: "",
  data,
  sensitivity: "public" as const,
  redacted: true,
  observedAt: "2026-01-01T00:00:00.000Z",
});

const contextWith = (overrides: Record<string, unknown> = {}) => ({
  project: { ...seedProject, accessMethods: [], memoryEntries: [] },
  run,
  recentMessages: [],
  memory: [],
  capabilities: ["public_internet" as const, "sftp" as const, "ssh" as const, "wordpress_admin" as const],
  evidence: [],
  environment: { primaryUrl: "https://example.com/", executionBackendAvailable: true },
  ...overrides,
});

// --- Pass 1: persistent working plan ----------------------------------------
console.log("\npass 1 — the plan is a real object, not a narration");
const action = planAction("inspect", "public_http.inspect_site", run.id, { url: "https://example.com/" });
if ("error" in action) throw new Error("fixture action failed to build");

let working = plan.emptyPlan(seedProject.id, run.id, "");
check("a fresh plan is empty", plan.isPlanEmpty(working));
working = plan.setGoal(working, "Find why the site is slow");
check("stating a goal makes the plan real", !plan.isPlanEmpty(working));
working = plan.reconcileSteps(working, [action]);
check("planned actions become steps", working.steps.length === 1);
check("a step is keyed by its invocation key", working.steps[0].id === plan.stepKeyFor(action));
check("a new step starts open", plan.openSteps(working).length === 1);
const reconciledTwice = plan.reconcileSteps(working, [action]);
check("re-planning the same action does not duplicate the step", reconciledTwice.steps.length === 1);
working = plan.markStep(working, plan.stepKeyFor(action), "done");
check("a finished step leaves the open list", plan.openSteps(working).length === 0);
working = plan.addHypotheses(working, ["A plugin is blocking the cache", "A plugin is blocking the cache"]);
check("identical hypotheses are not restated", working.hypotheses.length === 1);
working = plan.resolveHypothesis(working, working.hypotheses[0].id, "ruled_out", "Cache headers are present");
check("a hypothesis can be ruled out", working.hypotheses[0].status === "ruled_out");

// --- Pass 2: read before write ----------------------------------------------
console.log("\npass 2 — nothing is changed before it is read");
const write = {
  ...action,
  toolId: "filesystem.write" as const,
  capability: "sftp" as const,
  risk: "medium_risk_change" as const,
  readOnly: false,
  args: { path: "/wp-content/themes/x/functions.php", contents: "x" },
};
check("a write names its target", writeTargetFor(write.toolId, write.args) === "file:/wp-content/themes/x/functions.php");
check("a read-only action has no write target", writeTargetFor(action.toolId, action.args) === null);
check("an unread target blocks the write", checkReadBeforeWrite(write, []).ok === false);

const readEvidence = evidenceOf("filesystem.read", {
  path: "/wp-content/themes/x/functions.php",
  contents: "before",
  contentHash: "hash-1",
});
check("reading the target first unblocks the write", checkReadBeforeWrite(write, [readEvidence]).ok === true);
check("the read ledger records the observed hash", readLedger([readEvidence]).size === 1);

// --- Pass 3: per-step verification ------------------------------------------
console.log("\npass 3 — a step is only done when it answered something");
check(
  "an observation carrying real signal verifies",
  verifyStep(action, [evidenceOf("public_http.inspect_site", { status: 200 })]).verdict === "verified",
);
check(
  "a hollow observation is inconclusive, not done",
  verifyStep(action, [evidenceOf("public_http.inspect_site", {})]).verdict === "inconclusive",
);
check("no evidence at all is never verified", verifyStep(action, []).verdict !== "verified");
check(
  "an empty list is still an answer",
  verifyStep({ ...action, toolId: "wordpress.list_plugins" as const }, [
    evidenceOf("wordpress.list_plugins", { plugins: [] }),
  ]).verdict === "verified",
);

// --- Pass 4: bounded parallel investigation ---------------------------------
console.log("\npass 4 — investigation is parallel but bounded");
check("parallel investigation has a hard ceiling", MAX_PARALLEL_INVESTIGATIONS > 1 && MAX_PARALLEL_INVESTIGATIONS <= 6);
check("the whole loop still has an iteration ceiling", MAX_AGENT_ITERATIONS > 0 && MAX_AGENT_ITERATIONS <= 12);
const orchestratorSource = await (await import("node:fs/promises")).readFile("src/agent-core/orchestrator.ts", "utf8");
check("only read-only work is batched", /readOnly/.test(orchestratorSource) && /Promise\.all/.test(orchestratorSource));
check("the parallel slice respects the budget", orchestratorSource.includes("MAX_PARALLEL_INVESTIGATIONS"));

// --- Pass 5: failure taxonomy ------------------------------------------------
console.log("\npass 5 — failures are classified, not just reported");
check("a timeout is transient", classifyFailure("timeout") === "transient");
check("an unauthorized call is a permission failure", classifyFailure("unauthorized") === "permission");
check("a transient failure retries once", escalate("timeout", 1).action === "retry");
check("a transient failure does not retry forever", escalate("timeout", 9).action !== "retry");
const permission = escalate("unauthorized", 1);
check("a permission failure asks the human", permission.action === "ask_human");
check("and asks for access rather than approval", permission.action === "ask_human" && permission.need === "access");
check(
  "three failures of one class exhaust the route",
  routeIsExhausted(
    [
      { toolId: "wordpress.read_health" as never, code: "timeout" as never },
      { toolId: "wordpress.list_plugins" as never, code: "timeout" as never },
      { toolId: "public_http.inspect_site" as never, code: "timeout" as never },
    ],
    "transient",
  ),
);

// --- Pass 6: diff-first approvals -------------------------------------------
console.log("\npass 6 — a high-risk approval shows the change");
const conversationSource = await (await import("node:fs/promises")).readFile("src/conversation.ts", "utf8");
const workspaceSource = await (await import("node:fs/promises")).readFile("src/ProjectWorkspace.tsx", "utf8");
check("the thread model carries a diff", /ThreadDiff/.test(conversationSource));
check("the diff names what is being changed", /target/.test(conversationSource) && /before/.test(conversationSource));
check("irreversible changes are called out", /irreversible/.test(conversationSource));
check("the workspace renders the diff for the human", workspaceSource.includes("pw-diff"));

// --- Pass 7: standing constraint memory --------------------------------------
console.log("\npass 7 — a rule stated once is a rule from then on");
const detected = detectConstraints("Never touch the checkout page. Always ask before deactivating a plugin.");
check("a prohibition is detected", detected.some((item) => /never touch/i.test(item.content)));
check("an obligation is detected", detected.some((item) => /always ask/i.test(item.content)));
check("a prohibition is critical", detected[0]?.importance === "critical");
check("ordinary conversation produces no rules", detectConstraints("The site feels slow on mobile today.").length === 0);
check("a question is not a rule", detectConstraints("Should we ever touch the checkout page?").length === 0);

const stored = detected.map((item, index) => ({
  id: `mem-${index}`,
  title: item.title,
  type: "constraint" as const,
  importance: item.importance,
  content: item.content,
}));
check("an already-stored rule is not saved twice", detected.every((item) => constraintAlreadyStored(stored, item)));
check(
  "a rule matches the thing it is about",
  constraintsTouching(stored, "file:/wp-content/themes/x/checkout.php").length === 1,
);
check("a rule does not match unrelated work", constraintsTouching(stored, "table:wp_options").length === 0);
check("a read-only target is never matched", constraintsTouching(stored, "").length === 0);

console.log("\npass 7 — the rule is enforced, not merely remembered");
const constrained = contextWith({
  project: { ...seedProject, accessMethods: [], memoryEntries: stored },
  run: { ...run, backupStatus: "confirmed" as const },
  evidence: [readEvidence, evidenceOf("filesystem.read", { path: "/checkout.php", contents: "a", contentHash: "h" })],
});
const checkoutWrite = { ...write, args: { path: "/checkout.php", contents: "x" } };
const blocked = evaluateAction(checkoutWrite, constrained);
check("a change touching a stated rule is refused", blocked.executable === false);
check("and it is escalated to the human", blocked.executable === false && blocked.requires === "approval");
check(
  "the refusal quotes the person's own words",
  blocked.executable === false && blocked.reason.toLowerCase().includes("checkout"),
);
const unrelated = evaluateAction(write, constrained);
check("unrelated changes are not blocked by the rule", unrelated.executable === true);

// --- Pass 8: close-out --------------------------------------------------------
console.log("\npass 8 — the run ends with an honest report");
check("a close-out is assembled from the plan", /close|closeout|closeOut/i.test(orchestratorSource));
check(
  "unverified steps are a real status",
  plan.markStep(working, working.steps[0].id, "unverified").steps[0].status === "unverified",
);

console.log(
  failures.length === 0
    ? "\nAll agent system-thinking checks passed."
    : `\n${failures.length} check(s) failed:\n${failures.map((name) => `  - ${name}`).join("\n")}`,
);
if (failures.length > 0) process.exit(1);
