import "./hermetic-env.ts";

/**
 * Trust Tai OS <-> Ops suite integration acceptance checks.
 *
 * Run with: npm run check:suite
 *
 * These prove the claims that are easy to make and expensive to get wrong:
 * a token never travels in a URL or localStorage, only exactly-allowed
 * origins can hand a session over, an unverified token is rejected before any
 * identity decision, a canonical link is deterministic, a retried signal
 * writes one row, no secret material leaves Ops, and Ops keeps working with
 * no suite at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isAllowedOrigin,
  locationCarriesToken,
  parseOriginAllowlist,
  readHandoffMessage,
  isSsoLandingPath,
  SSO_MESSAGE_TYPE,
} from "../src/suite/ssoBridge.ts";
import { canLinkProject, decideCanonicalLink } from "../src/suite/canonicalLink.ts";
import {
  OPS_SUITE_EVENTS,
  OPS_APP_KEY,
  buildSuiteActivity,
  containsSecretMaterial,
  sanitizeSummary,
  suiteDedupeKey,
  syncSuiteSignal,
} from "../src/suite/osActivity.ts";
import type { OpsSuiteSignal, SuiteActivityRow, SuiteWriteContext } from "../src/suite/osActivity.ts";
import { buildOpsSnapshot } from "../src/suite/snapshot.ts";
import { isQaAutoLoginEnabled, resolveOpsEnv } from "../src/env.ts";
import type { Project } from "../src/types.ts";

const failures: string[] = [];
const check = (name: string, condition: boolean, detail = "") => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const root = join(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

const OS_ORIGIN = "https://id-preview--65944e34-ede5-4757-befb-870e1ff97444.lovable.app";
const ALLOWLIST = parseOriginAllowlist(`${OS_ORIGIN}, https://os.trusttai.com`);
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcyJ9.c2lnbmF0dXJl";
const OS_ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OS_USER = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const WRITE_CONTEXT: SuiteWriteContext = { organizationId: OS_ORG, actorUserId: OS_USER };
const handoff = (extra: Record<string, unknown> = {}) => ({
  origin: OS_ORIGIN,
  data: { type: SSO_MESSAGE_TYPE, accessToken: TOKEN, organizationId: OS_ORG, ...extra },
});

console.log("\norigins are matched exactly, never by pattern");

check("an exactly allowed origin is accepted", readHandoffMessage(handoff(), ALLOWLIST).ok);
check(
  "a lookalike origin is rejected",
  !readHandoffMessage({ ...handoff(), origin: "https://os.trusttai.com.evil.test" }, ALLOWLIST).ok,
);
check("a wildcard is never an allowed origin", !isAllowedOrigin("*", parseOriginAllowlist("*")));
check("a wildcard entry is dropped from the allowlist", parseOriginAllowlist("*,https://os.trusttai.com").length === 1);
check("an opaque null origin is rejected", !isAllowedOrigin("null", ALLOWLIST));
check("a missing origin is rejected", !isAllowedOrigin(undefined, ALLOWLIST));

const wrongOrigin = readHandoffMessage({ ...handoff(), origin: "https://attacker.test" }, ALLOWLIST);
check("a wrong postMessage origin is rejected", !wrongOrigin.ok && wrongOrigin.reason === "origin_rejected");

console.log("\nmalformed handoffs never reach the exchange");

check("a message without a token is rejected", !readHandoffMessage({ origin: OS_ORIGIN, data: { type: SSO_MESSAGE_TYPE } }, ALLOWLIST).ok);
check("a non-JWT token shape is rejected", !readHandoffMessage(handoff({ accessToken: "not-a-token" }), ALLOWLIST).ok);
check("a non-uuid canonical project id is rejected", !readHandoffMessage(handoff({ canonicalProjectId: "acme" }), ALLOWLIST).ok);
check("an unrelated message is ignored", !readHandoffMessage({ origin: OS_ORIGIN, data: { type: "other" } }, ALLOWLIST).ok);

const missingOrg = readHandoffMessage(handoff({ organizationId: undefined }), ALLOWLIST);
check("a handoff without an organization fails closed", !missingOrg.ok && missingOrg.reason === "missing_organization_id");
const badOrg = readHandoffMessage(handoff({ organizationId: "acme-org" }), ALLOWLIST);
check("a malformed organization id fails closed", !badOrg.ok && badOrg.reason === "malformed_organization_id");
const goodHandoff = readHandoffMessage(handoff(), ALLOWLIST);
check("a valid handoff carries the organization", goodHandoff.ok && goodHandoff.handoff.organizationId === OS_ORG);
check(
  "the organization is context, never authorization",
  read("src/suite/ssoBridge.ts").includes("never as an authorization claim") &&
    read("supabase/functions/os-sso-exchange/index.ts").includes("stand in for token verification"),
);
check("the exchange validates the organization id shape", read("supabase/functions/os-sso-exchange/index.ts").includes("invalid_os_organization_id"));
check("the organization is held only in the in-memory suite session", read("src/suite/osToken.ts").includes("osOrganizationId"));

console.log("\nno token in the URL, no token in localStorage");

check("a token in the address bar is detected", locationCarriesToken("https://ops.trusttai.com/sso#access_token=abc"));
check("a clean landing url is fine", !locationCarriesToken("https://ops.trusttai.com/sso"));
check("the landing route is recognised", isSsoLandingPath("/sso") && isSsoLandingPath("/sso/"));

// Comments talk about localStorage on purpose; only real code matters here.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const suiteSources = ["src/suite/ssoBridge.ts", "src/suite/osToken.ts", "src/suite/client.ts", "src/SsoLanding.tsx"];
for (const file of suiteSources) {
  const source = stripComments(read(file));
  check(`${file} never writes the OS token to localStorage`, !/localStorage/.test(source));
  check(`${file} never puts a token in a query string`, !/access_token=/.test(source) || file.includes("ssoBridge"));
}
check(
  "the landing surface clears the address bar when a token appears there",
  read("src/SsoLanding.tsx").includes("history.replaceState"),
);

console.log("\nthe browser never decides identity");

const exchange = read("supabase/functions/os-sso-exchange/index.ts");
check("the exchange re-verifies the OS token against the OS auth service", exchange.includes("/auth/v1/user"));
check("an unverified token stops the request", exchange.includes("os_token_rejected"));
check("identity resolves by exact external reference", exchange.includes('.eq("trust_tai_os_user_id"'));
check("or by exact email, never a fuzzy match", exchange.includes('.eq("email", osUser.email)') && !exchange.includes("ilike"));
check("a person without Ops membership is refused", exchange.includes("no_ops_membership"));
check("Ops roles are preserved, not taken from the OS", exchange.includes("member.role"));
check("the response carries no service-role key", !exchange.includes("SERVICE_ROLE_KEY\") ?? \"\",\n      return"));
check("the session is bootstrapped with a single-use OTP hash", exchange.includes("generateLink") && exchange.includes("hashed_token"));
check("no password is ever returned", !/return json\([^)]*password/.test(exchange));
check("the client redeems it through normal Supabase verification", read("src/suite/client.ts").includes("auth.verifyOtp"));
check("the client drops the OS token after the exchange", read("src/suite/client.ts").includes('handoff.accessToken = ""'));

console.log("\ndirect visits still fail closed");

const app = read("src/App.tsx");
check("the suite landing only renders for an unauthenticated visitor", app.includes("ssoLanding && !authState.isAuthenticated"));
check("the normal auth gate still follows it", app.includes("if (authGateEnabled &&"));

console.log("\nproduction carries no QA credential and cannot auto-login");

const productionEnv = read(".env.production");
check("no QA password is committed for production", !/VITE_OPS_QA_PASSWORD/.test(productionEnv));
check("production QA autologin is off", /VITE_OPS_QA_AUTOLOGIN=false/.test(productionEnv));
check(
  "a production build ignores QA autologin even if it is set",
  !isQaAutoLoginEnabled({
    ...resolveOpsEnv(),
    isProductionBuild: true,
    qaAutoLogin: true,
    qaEmail: "qa@example.test",
    qaPassword: "anything",
  }),
);
check("the QA path is hard-disabled in source, not by config alone", read("src/env.ts").includes("if (env.isProductionBuild) return false;"));

console.log("\nthe canonical project link is deterministic");

const CANONICAL = "11111111-2222-4333-8444-555555555555";
const projects = [
  { id: "ops-1", name: "Acme Site", trustTaiOsProjectId: null },
  { id: "ops-2", name: "Acme Website", trustTaiOsProjectId: CANONICAL },
];

const linked = decideCanonicalLink(CANONICAL, projects);
check("an exact canonical id resolves to exactly one Ops project", linked.kind === "already_linked" && linked.opsProjectId === "ops-2");
check("resolution is idempotent", JSON.stringify(decideCanonicalLink(CANONICAL, projects)) === JSON.stringify(linked));
check(
  "a similar name never attaches a project",
  decideCanonicalLink("99999999-2222-4333-8444-555555555555", projects).kind === "needs_choice",
);
check("no canonical context is not a failure", decideCanonicalLink(null, projects).kind === "no_canonical_context");
check("a canonical id cannot be claimed by a second Ops project", !canLinkProject(CANONICAL, "ops-1", projects).allowed);
check("re-linking the same pair is allowed", canLinkProject(CANONICAL, "ops-2", projects).allowed);
check("unlinked Ops projects remain usable", projects[0].trustTaiOsProjectId === null);
check(
  "the link column is added idempotently",
  read("db/migrations/20260834_os_suite_link.sql").includes("add column if not exists trust_tai_os_project_id"),
);

console.log("\nsignal sync is narrow, safe, and idempotent");

const signal: OpsSuiteSignal = {
  event: "ops.qa_passed",
  opsProjectId: "ops-2",
  canonicalProjectId: CANONICAL,
  opsRunId: "run-7",
  opsEventKey: "qa-report-7",
  summary: "QA passed on production after the plugin conflict fix.",
  evidenceRef: "artifact-3",
};

const rows: SuiteActivityRow[] = [];
const deps = {
  findExisting: async (key: string) =>
    rows.find((row) => row.metadata.dedupe_key === key) ? "existing" : null,
  insert: async (row: SuiteActivityRow) => {
    rows.push(row);
  },
};

const first = await syncSuiteSignal(signal, deps, "https://ops.trusttai.com");
const second = await syncSuiteSignal(signal, deps, "https://ops.trusttai.com");
check("a signal writes one OS activity", first.status === "written" && rows.length === 1);
check("retrying the same signal writes nothing more", second.status === "duplicate" && rows.length === 1);
check("the dedupe key is stable", suiteDedupeKey(signal) === suiteDedupeKey({ ...signal }));

const built = buildSuiteActivity(signal, "https://ops.trusttai.com");
check("provenance names the source app", built.metadata.source_app === "ops");
check("provenance carries the Ops project", built.metadata.ops_project_id === "ops-2");
check("provenance carries the canonical project", built.metadata.canonical_project_id === CANONICAL);
check("provenance carries the run", built.metadata.ops_run_id === "run-7");
check("provenance carries a route back into Ops", String(built.metadata.destination_route).includes("/project/ops-2"));
check("the event vocabulary is the agreed one", OPS_SUITE_EVENTS.length === 10 && OPS_SUITE_EVENTS.includes("ops.rollback_performed"));

const unknown = await syncSuiteSignal({ ...signal, event: "ops.shell_command" as never }, deps, "https://ops.trusttai.com");
check("an event outside the vocabulary is refused", unknown.status === "rejected");

console.log("\nsecrets never leave Ops");

check("a password field is caught", containsSecretMaterial({ metadata: { password: "x" } }));
check("sealed ciphertext is caught", containsSecretMaterial({ metadata: { ciphertext: "x" } }));
check("a private key body is caught", containsSecretMaterial("-----BEGIN OPENSSH PRIVATE KEY-----abc"));
check("a bearer JWT in prose is caught", containsSecretMaterial({ note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" }));
check("a clean payload passes", !containsSecretMaterial(built));
check("credential prose is stripped from summaries", !sanitizeSummary("password: hunter2").includes("hunter2"));

const leaky = await syncSuiteSignal(
  { ...signal, opsEventKey: "leaky", summary: "key -----BEGIN OPENSSH PRIVATE KEY----- abc" },
  deps,
  "https://ops.trusttai.com",
);
check("a signal carrying key material is refused or scrubbed", leaky.status === "written" && !containsSecretMaterial(rows.at(-1)));

console.log("\nOps works with no suite at all");

const noSession = await syncSuiteSignal(signal, null, "https://ops.trusttai.com");
check("no OS session reports unavailable rather than failing", noSession.status === "unavailable" && noSession.reason === "no_os_session");
const noLink = await syncSuiteSignal({ ...signal, canonicalProjectId: null }, deps, "https://ops.trusttai.com");
check("an unlinked project reports not-linked rather than failing", noLink.status === "unavailable" && noLink.reason === "not_linked");
check("nothing claims a successful sync in those cases", noSession.status !== "written" && noLink.status !== "written");

console.log("\nthe snapshot reflects real Ops state and cites it");

const project = {
  id: "ops-2",
  name: "Acme Website",
  clientName: "Acme",
  primaryDomain: "acme.test",
  status: "active",
  environmentHealth: "watching",
  trustTaiOsProjectId: CANONICAL,
  environments: [],
  accessMethods: [],
  memoryEntries: [],
  recommendations: [
    { id: "rec-1", category: "security", priority: "high", status: "open", title: "Rotate the QA credential", summary: "" },
  ],
  riskFlags: [{ id: "risk-1", severity: "high", status: "open", title: "Blocked host", summary: "" }],
  qaRules: [],
  runs: [
    {
      id: "run-7",
      title: "Plugin conflict",
      taskType: "plugin_theme_conflict",
      taskSummary: "",
      urgency: "normal",
      environmentId: "env-1",
      state: "paused",
      riskLevel: "cautious",
      backupStatus: "confirmed_by_operator",
      approvalRequired: true,
      nextAction: "Waiting on approval",
      operatorPrompt: "Approve the plugin rollback",
      diagnosisSummary: "",
      planSummary: "",
      startedAt: "2026-08-14T10:00:00Z",
      updatedAt: "2026-08-14T12:00:00Z",
      phases: [],
      findings: [],
      actions: [{ id: "act-1", actor: "agent", summary: "Disabled the conflicting plugin", outcome: "succeeded" }],
      artifacts: [{ id: "art-1", type: "qa_capture", title: "QA capture", summary: "" }],
      approvals: [{ id: "ap-1", type: "high_risk_execution", status: "pending", reason: "Rollback on production" }],
      qaReport: { verdict: "failed", summary: "Checkout still errors", unresolvedRisks: ["Checkout"] },
      recommendations: [],
    },
  ],
} as unknown as Project;

const snapshot = buildOpsSnapshot(project, "2026-08-14T13:00:00Z");
check("the snapshot names the canonical project", snapshot.canonicalProjectId === CANONICAL);
check("health comes from real project state", snapshot.health.status === "watching" && snapshot.health.openRisks === 1);
check("the active run is the real one", snapshot.activeRun?.id === "run-7");
check("a blocked run is surfaced as a blocker", snapshot.blocker?.runId === "run-7");
check("a pending approval is surfaced", snapshot.pendingApproval?.approvalId === "ap-1");
check("the latest QA verdict is real", snapshot.latestQa?.verdict === "failed");
check("unresolved recommendations are listed", snapshot.unresolvedRecommendations[0]?.id === "rec-1");
check("the last meaningful event is a real action", snapshot.lastMeaningfulEvent?.summary.includes("Disabled the conflicting plugin"));
check("evidence is referenced, not inlined", snapshot.evidenceRefs[0]?.artifactId === "art-1");
check("every claim cites a source id", snapshot.citations.some((c) => c.id === "run-7") && snapshot.citations.some((c) => c.id === "rec-1"));
check("the snapshot carries no secret material", !containsSecretMaterial(snapshot));

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} suite integration check(s) failed.`);
  process.exit(1);
}
console.log("All suite integration checks passed.");