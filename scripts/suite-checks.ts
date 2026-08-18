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
  sanitizeTargetPath,
  projectIdFromTargetPath,
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
import {
  ACCEPTANCE_SUMMARY,
  acceptanceEventKey,
  acceptanceSignal,
  describeSyncResult,
  resolveAcceptanceTarget,
} from "../src/suite/acceptance.ts";
import { isQaAutoLoginEnabled, osOriginSourceForBuild, resolveOpsEnv, OS_PRODUCTION_ORIGIN } from "../src/env.ts";
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
  occurredAt: "2026-08-14T12:00:00.000Z",
};

const rows: SuiteActivityRow[] = [];
const deps = {
  context: WRITE_CONTEXT,
  findExisting: async (key: string) =>
    rows.find((row) => row.source_event_key === key) ? "existing" : null,
  insert: async (row: SuiteActivityRow): Promise<"written" | "duplicate"> => {
    rows.push(row);
    return "written";
  },
};

const first = await syncSuiteSignal(signal, deps, "https://ops.trusttai.com");
const second = await syncSuiteSignal(signal, deps, "https://ops.trusttai.com");
check("a signal writes one OS activity", first.status === "written" && rows.length === 1);
check("retrying the same signal writes nothing more", second.status === "duplicate" && rows.length === 1);
check("the dedupe key is stable", suiteDedupeKey(signal) === suiteDedupeKey({ ...signal }));

const built = buildSuiteActivity(signal, "https://ops.trusttai.com", WRITE_CONTEXT);

console.log("\nthe row matches the live OS activities contract exactly");

// The live public.activities columns, verbatim. Anything else is a write that
// PostgREST will reject.
const LIVE_COLUMNS = [
  "id",
  "organization_id",
  "event_type",
  "actor_user_id",
  "app_key",
  "entity_type",
  "entity_id",
  "summary",
  "payload",
  "provenance",
  "source_event_key",
  "occurred_at",
  "created_at",
];
const REQUIRED_COLUMNS = [
  "organization_id",
  "event_type",
  "app_key",
  "payload",
  "provenance",
  "source_event_key",
  "occurred_at",
];
const written = Object.keys(built);

check("no column outside the live schema is sent", written.every((key) => LIVE_COLUMNS.includes(key)), written.join(", "));
check("every required column is present and non-null", REQUIRED_COLUMNS.every((key) => (built as Record<string, unknown>)[key] != null));
check("the retired activity_type column is gone", !written.includes("activity_type"));
check("the retired project_id column is gone", !written.includes("project_id"));
check("the retired metadata column is gone", !written.includes("metadata"));
check("id and created_at are left to the database", !written.includes("id") && !written.includes("created_at"));
check("organization_id comes from the handoff", built.organization_id === OS_ORG);
check("event_type carries the ops.* event", built.event_type === "ops.qa_passed");
check("app_key identifies Ops", built.app_key === OPS_APP_KEY && OPS_APP_KEY === "ops");
check("actor_user_id is the verified OS user", built.actor_user_id === OS_USER);
check(
  "an unknown actor is left null for RLS to decide",
  buildSuiteActivity(signal, "https://ops.trusttai.com", { organizationId: OS_ORG }).actor_user_id === null,
);
check("entity_type is project when a canonical project exists", built.entity_type === "project");
check("entity_id is the canonical project", built.entity_id === CANONICAL);
check("occurred_at is the real event time, not a fabricated one", built.occurred_at === "2026-08-14T12:00:00.000Z");
check(
  "a signal with no time is stamped at emission only",
  Date.parse(buildSuiteActivity({ ...signal, occurredAt: null }, "https://ops.trusttai.com", WRITE_CONTEXT).occurred_at) > 0,
);
check("payload carries the Ops project", built.payload.ops_project_id === "ops-2");
check("payload carries the canonical project", built.payload.canonical_project_id === CANONICAL);
check("payload carries the run", built.payload.ops_run_id === "run-7");
check("payload carries a route back into Ops", String(built.payload.destination_route).includes("/project/ops-2"));
check("provenance names the source app", built.provenance.source_app === "ops" && built.provenance.source === "trust-tai-ops");
check("provenance carries the Ops event key", built.provenance.ops_event_key === "qa-report-7");
check("provenance carries the dedupe key", built.provenance.dedupe_key === suiteDedupeKey(signal));
check("source_event_key matches the same deterministic invariant", built.source_event_key === suiteDedupeKey(signal));
check(
  "the dedupe read filters on the indexed source_event_key column",
  read("src/suite/client.ts").includes("source_event_key=eq.") && !read("src/suite/client.ts").includes("metadata->>"),
);
check("a 409 unique violation is treated as a duplicate", read("src/suite/client.ts").includes("status === 409"));
check("a write with no organization is refused", (await syncSuiteSignal(signal, { ...deps, context: { organizationId: "" } }, "https://ops.trusttai.com")).status === "unavailable");
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
console.log("the temporary suite acceptance harness");

const acceptanceSession = {
  osAccessToken: TOKEN,
  osUserId: OS_USER,
  osEmail: "person@trusttai.com",
  osOrganizationId: OS_ORG,
  canonicalProjectId: CANONICAL,
  expiresAt: 0,
};
const linkedProjects = [{ id: "ops-project-1", trustTaiOsProjectId: CANONICAL }];

check(
  "the control is hidden with no suite session",
  resolveAcceptanceTarget(null, linkedProjects) === null,
);
check(
  "the control is hidden with no canonical project id",
  resolveAcceptanceTarget({ ...acceptanceSession, canonicalProjectId: null }, linkedProjects) === null,
);
check(
  "the control is hidden when no Ops project is linked to that canonical project",
  resolveAcceptanceTarget(acceptanceSession, [{ id: "ops-project-2", trustTaiOsProjectId: null }]) === null,
);

const acceptanceTarget = resolveAcceptanceTarget(acceptanceSession, linkedProjects);
check("the control appears for a live session on a linked project", acceptanceTarget?.opsProjectId === "ops-project-1");

const fixture = acceptanceSignal(acceptanceTarget!);
check(
  "the acceptance event key is deterministic and canonical-scoped",
  fixture.opsEventKey === `suite-acceptance-v1:${CANONICAL}` &&
    fixture.opsEventKey === acceptanceEventKey(CANONICAL) &&
    acceptanceSignal(acceptanceTarget!).opsEventKey === fixture.opsEventKey,
);

const fixtureRow = buildSuiteActivity(fixture, "https://ops.trusttai.com", WRITE_CONTEXT);
check(
  "the row is clearly marked as a temporary acceptance test",
  fixtureRow.summary === ACCEPTANCE_SUMMARY &&
    fixtureRow.summary.includes("TEMPORARY SUITE ACCEPTANCE TEST") &&
    String(fixtureRow.payload.evidence_summary).includes("Acceptance-only harness event"),
);
check(
  "the fixture row carries the deterministic indexed key and a valid Ops route",
  fixtureRow.source_event_key === suiteDedupeKey(fixture) &&
    fixtureRow.payload.destination_route === `https://ops.trusttai.com/project/ops-project-1`,
);
check("the fixture row carries no secret material", !containsSecretMaterial(fixtureRow));

const panelSource = read("src/SuiteAcceptancePanel.tsx");
check(
  "the control uses the production sync path, not a direct OS insert",
  panelSource.includes("sendSuiteSignal") && !panelSource.includes("/rest/v1/activities") && !panelSource.includes("fetch("),
);

let sent = 0;
const stored = new Set<string>();
const fakeDeps = {
  context: WRITE_CONTEXT,
  findExisting: async (key: string) => (stored.has(key) ? "activity-1" : null),
  insert: async (row: SuiteActivityRow) => {
    sent += 1;
    stored.add(row.source_event_key);
    return "written" as const;
  },
};
const firstPress = await syncSuiteSignal(fixture, fakeDeps, "https://ops.trusttai.com");
const secondPress = await syncSuiteSignal(fixture, fakeDeps, "https://ops.trusttai.com");
check(
  "pressing twice writes exactly one row",
  firstPress.status === "written" && secondPress.status === "duplicate" && sent === 1,
);
check(
  "a duplicate is rendered honestly, not as a fresh write",
  describeSyncResult(secondPress).label === "Duplicate" &&
    describeSyncResult(secondPress).detail.includes("no second row"),
);
check(
  "a failure is rendered honestly with its reason",
  describeSyncResult({ status: "failed", reason: "os_activity_write_failed" }).tone === "bad" &&
    describeSyncResult({ status: "unavailable", reason: "no_os_session" }).detail.includes("no os session"),
);

console.log("\nproduction Core origin is trusted, preview origins stay out of production");

const PROD_ORIGIN = "https://cmd.trusttai.com";
const PREVIEW_ORIGIN = "https://id-preview--65944e34-ede5-4757-befb-870e1ff97444.lovable.app";
const baseEnv = resolveOpsEnv();
const prodEnv = {
  ...baseEnv,
  isProductionBuild: true,
  osOriginAllowlistRaw: PREVIEW_ORIGIN,
  osProductionOriginsRaw: PROD_ORIGIN,
};
const devEnv = { ...prodEnv, isProductionBuild: false };
const prodAllow = parseOriginAllowlist(osOriginSourceForBuild(prodEnv));
const devAllow = parseOriginAllowlist(osOriginSourceForBuild(devEnv));

check("the production Core origin constant is cmd.trusttai.com", OS_PRODUCTION_ORIGIN === PROD_ORIGIN);
check("a production build trusts the production Core origin", prodAllow.includes(PROD_ORIGIN));
check("a production build does not trust preview origins", !prodAllow.includes(PREVIEW_ORIGIN));
check("a production build trusts nothing else", prodAllow.length === 1);
check("a preview build still trusts its preview origin", devAllow.includes(PREVIEW_ORIGIN));
check("a preview build also accepts the real production Core origin", devAllow.includes(PROD_ORIGIN));
check(
  "a production handoff from Core is accepted",
  readHandoffMessage({ ...handoff(), origin: PROD_ORIGIN }, prodAllow).ok,
);
check(
  "a malicious lookalike of the production origin is rejected",
  !readHandoffMessage({ ...handoff(), origin: "https://cmd.trusttai.com.attacker.test" }, prodAllow).ok &&
    !readHandoffMessage({ ...handoff(), origin: "http://cmd.trusttai.com" }, prodAllow).ok,
);
check(
  "the landing surface reads the environment-separated allowlist",
  read("src/SsoLanding.tsx").includes("osOriginSourceForBuild"),
);

console.log("\ntargetPath deep links stay inside this app");

check("a project deep link is accepted", sanitizeTargetPath("/project/" + OS_ORG) === "/project/" + OS_ORG);
check("an absolute external url is refused", sanitizeTargetPath("https://evil.test/x") === null);
check("a protocol-relative path is refused", sanitizeTargetPath("//evil.test/x") === null);
check("a javascript scheme is refused", sanitizeTargetPath("/\tjavascript:alert(1)") === null);
check("a backslash escape is refused", sanitizeTargetPath("/\\evil.test") === null);
check("traversal is refused", sanitizeTargetPath("/project/../../admin") === null);
check("an encoded escape is refused", sanitizeTargetPath("/%2f%2fevil.test") === null);
check("a non-string is refused", sanitizeTargetPath(undefined) === null && sanitizeTargetPath(42) === null);
check("landing back on the handoff surface is refused", sanitizeTargetPath("/sso") === null);
check(
  "a handoff carries its sanitized target path",
  (readHandoffMessage(handoff({ targetPath: "/project/" + OS_ORG }), ALLOWLIST) as { handoff: { targetPath: string | null } }).handoff.targetPath ===
    "/project/" + OS_ORG,
);
check(
  "a hostile target path is dropped without rejecting the handoff",
  (() => {
    const result = readHandoffMessage(handoff({ targetPath: "https://evil.test" }), ALLOWLIST);
    return result.ok && result.handoff.targetPath === null;
  })(),
);
check("a project id is read from a sanitized path", projectIdFromTargetPath("/project/" + OS_ORG) === OS_ORG);
check("no project id is invented from an unrelated path", projectIdFromTargetPath("/settings") === null);
check(
  "the app only deep links to a project the session can actually see",
  read("src/App.tsx").includes("projectIdFromTargetPath") && read("src/App.tsx").includes("stored.projects.some"),
);

console.log("\nthe exchange proves identity server-side and fails closed");

const exchangeSource = read("supabase/functions/os-sso-exchange/index.ts");
check("Core tokens are verified against the OS auth service", exchangeSource.includes("/auth/v1/user"));
check("an unverified token is rejected before any identity decision", exchangeSource.includes("os_token_rejected"));
check("a caller with no Ops membership is refused", exchangeSource.includes("no_ops_membership"));
check("a disabled Ops account is refused", exchangeSource.includes("ops_access_disabled"));
check(
  "membership is resolved exactly, never fuzzily",
  exchangeSource.includes('.eq("trust_tai_os_user_id"') && exchangeSource.includes('.eq("email"') && !exchangeSource.includes(".ilike("),
);
check(
  "the browser receives a single-use OTP hash, never a service key",
  exchangeSource.includes("hashed_token") && !exchangeSource.includes("return json({ ok: true, serviceRole"),
);
check(
  "the Ops session is minted through the normal Supabase client",
  read("src/suite/client.ts").includes("verifyOtp"),
);

console.log("");

if (failures.length > 0) {
  console.log(`${failures.length} suite integration check(s) failed.`);
  process.exit(1);
}
console.log("All suite integration checks passed.");