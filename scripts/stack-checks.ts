import "./hermetic-env.ts";

/**
 * Multi-stack release closure checks.
 *
 * Run with: npm run check:stacks
 *
 * These prove the parts of the multi-stack work that are easy to claim and
 * hard to see: the server, not the browser, decides whether a WordPress tool
 * may run; the access surface never calls a bare record "stored securely";
 * the deploy narrative is task-aware; and the schema/type/migration set says
 * what the code assumes.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  WORDPRESS_TOOLS,
  authorizeToolForStack,
  effectiveStack,
  isWordPressTool,
} from "../supabase/functions/_shared/stackGuard.ts";
import { isToolEligibleForStack } from "../src/agent-core/policy.ts";
import { materializeServerPlan } from "../src/agent-core/reasonPlan.ts";
import { normalizeVersions, accessTypesForStack, stackCopy, adminCredentialLabel } from "../src/stacks.ts";

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

/* ------------------------------------------------------------------ */
/* 1. Server-side stack enforcement                                    */
/* ------------------------------------------------------------------ */

const WP_TOOL_LIST = [
  "wordpress.inspect_public_surface",
  "wordpress.read_health",
  "wordpress.list_plugins",
  "wordpress.run_wp_cli_readonly",
  "wordpress.read_error_log",
  "wordpress.execute_wp_cli",
];

for (const toolId of WP_TOOL_LIST) {
  check(`server guard knows ${toolId} is WordPress-only`, isWordPressTool(toolId));
}
check("public_http.inspect_site stays stack neutral", !isWordPressTool("public_http.inspect_site"));
check("guard list has no extra entries", WORDPRESS_TOOLS.size === WP_TOOL_LIST.length);

const meteorDeps = {
  loadEnvironmentStacks: async () => [
    { environment_type: "staging", stack: "meteor" },
    { environment_type: "production", stack: "meteor" },
  ],
};

for (const toolId of WP_TOOL_LIST) {
  const verdict = await authorizeToolForStack(meteorDeps, "bioptrics", toolId);
  check(
    `Meteor project is refused ${toolId}`,
    !verdict.ok && verdict.code === "stack_not_supported" && verdict.summary.includes("Meteor"),
  );
}

const neutral = await authorizeToolForStack(meteorDeps, "bioptrics", "public_http.inspect_site");
check("Meteor project may still inspect its public site", neutral.ok);

// A legacy row with no stack value is what it always was: WordPress.
const legacy = await authorizeToolForStack(
  { loadEnvironmentStacks: async () => [{ environment_type: "production", stack: null }] },
  "epaypolicy",
  "wordpress.read_health",
);
check("legacy environment without a stack is treated as WordPress", legacy.ok);

// Fail closed: an unreadable project never becomes an executable one.
const broken = await authorizeToolForStack(
  { loadEnvironmentStacks: async () => { throw new Error("no"); } },
  "unknown",
  "wordpress.list_plugins",
);
check("unreadable project fails closed", !broken.ok && broken.code === "execution_context_unavailable");

check("production environment wins over the first row", effectiveStack([
  { environment_type: "staging", stack: "wordpress" },
  { environment_type: "production", stack: "meteor" },
]) === "meteor");
check("no environments falls back to WordPress", effectiveStack([]) === "wordpress");

const execute = read("supabase/functions/agent-execute/index.ts");
check("agent-execute imports the stack guard", execute.includes("authorizeToolForStack"));
check("agent-execute gates before dispatch", execute.indexOf("authorizeToolForStack") < execute.indexOf("switch (toolId)"));
check("agent-execute refuses unauthenticated WordPress calls", /isWordPressTool\(toolId\)/.test(execute));

/* ------------------------------------------------------------------ */
/* 2. Client defense in depth                                          */
/* ------------------------------------------------------------------ */

for (const toolId of WP_TOOL_LIST) {
  check(`client policy blocks ${toolId} on Meteor`, !isToolEligibleForStack(toolId, "meteor"));
  check(`client policy allows ${toolId} on WordPress`, isToolEligibleForStack(toolId, "wordpress"));
}

const wpPlan = {
  intent: "inspect_public_surface",
  rationale: "Look at the public surface.",
  steps: [{ id: "inspect-wp-public" }],
};
check(
  "server plan with a WordPress step is rejected for Meteor",
  materializeServerPlan(wpPlan, { runId: "r1", url: "https://x.test", capabilities: ["public_internet"], stack: "meteor" }) === null,
);
check(
  "the same plan still materializes for WordPress",
  materializeServerPlan(wpPlan, { runId: "r1", url: "https://x.test", capabilities: ["public_internet"], stack: "wordpress" }) !== null,
);

const accessPlan = materializeServerPlan(
  { intent: "request_access", rationale: "I need a way in.", requestedAccess: ["wordpress_admin", "ssh", "server_pm2"] },
  { runId: "r1", url: "https://x.test", capabilities: [], stack: "meteor" },
);
check("requested access is filtered to the active stack", Boolean(accessPlan) &&
  !(accessPlan!.decision.requestedAccess ?? []).includes("wordpress_admin") &&
  (accessPlan!.decision.requestedAccess ?? []).includes("ssh"));
check("new access types survive the filter", (accessPlan!.decision.requestedAccess ?? []).includes("server_pm2"));

const reasoner = read("src/agent-core/reasoner.ts");
check("reasoning digest tells the server what the project runs on", /stack:\s*getProjectStack/.test(reasoner));

/* ------------------------------------------------------------------ */
/* 3. Access truth semantics                                           */
/* ------------------------------------------------------------------ */

const accessPanel = read("src/ProjectAccessPanel.tsx");
check("a record with no sealed credential is never 'Stored securely'", accessPanel.includes("hasSealedCredential"));
check("access status checks the credential reference", /credentialReference/.test(accessPanel));
check("SSH drawer strips the WordPress folder field off other stacks", accessPanel.includes('field.key !== "wpRoot"'));
check("non-WordPress SSH copy does not promise command execution", accessPanel.includes("isn't enabled yet"));
check("admin credential label is only used where a credential exists", accessPanel.includes("adminCredentialLabel"));

const lib = read("src/lib.ts");
check("creating a project never stamps a verification time", !/lastVerifiedAt:\s*nowStamp/.test(lib));

/* ------------------------------------------------------------------ */
/* 4. Deploy narrative + pipeline presentation                         */
/* ------------------------------------------------------------------ */

check("deploy runs get their own narrative", /taskType === "deploy"/.test(lib) && lib.includes("Pre-deploy verification"));
check("deploy narrative covers all four states", ["environment_mapping", "diagnosis", "execution", "qa"].every((state) =>
  new RegExp(`${state}:\\s*\\{`).test(lib)));

const pipeline = read("src/ProjectPipelineSummary.tsx");
for (const fact of ["Staging", "Branch gated", "Auto deploy", "Build", "Rollback", "Production"]) {
  check(`pipeline summary shows ${fact}`, pipeline.includes(fact));
}
for (const file of ["src/ProjectWorkspace.tsx", "src/ProjectsCommandCenter.tsx", "src/ProjectEmptyState.tsx"]) {
  check(`${file} renders the pipeline summary`, read(file).includes("ProjectPipelineSummary"));
}

/* ------------------------------------------------------------------ */
/* 5. Stack copy + global neutrality                                   */
/* ------------------------------------------------------------------ */

check("wordpress descriptor", stackCopy.wordpress.descriptor === "WordPress engineering");
check("meteor descriptor", stackCopy.meteor.descriptor === "Application engineering");
check("nextjs descriptor", stackCopy.nextjs.descriptor === "Full-stack engineering");
check("custom descriptor", stackCopy.custom.descriptor === "Systems engineering");
check("only WordPress exposes an admin credential surface",
  adminCredentialLabel("wordpress") === "WordPress Admin" &&
  adminCredentialLabel("meteor") === null &&
  adminCredentialLabel("nextjs") === null &&
  adminCredentialLabel("custom") === null);
check("Meteor access choices exclude WordPress Admin", !accessTypesForStack("meteor").includes("wordpress_admin"));
check("WordPress access choices keep WordPress Admin", accessTypesForStack("wordpress").includes("wordpress_admin"));

check("sign-in copy is stack neutral", !/WordPress engineering command center/.test(read("src/AuthScreen.tsx")));
check("workspace descriptor is stack neutral", !/descriptor: "WordPress engineering command center"/.test(read("src/seed.ts")));

/* ------------------------------------------------------------------ */
/* 6. Hydration                                                        */
/* ------------------------------------------------------------------ */

const legacyVersions = normalizeVersions({ wordpressVersion: "6.7.1", phpVersion: "8.2" });
check("legacy columns hydrate into a versions map",
  legacyVersions.wordpress === "6.7.1" && legacyVersions.php === "8.2");
const meteorVersions = normalizeVersions({ versions: { meteor: "2.15", node: "22.22.1" } });
check("a Meteor versions map round-trips", meteorVersions.meteor === "2.15" && meteorVersions.node === "22.22.1");

const repository = read("src/repository.ts");
check("hydration defaults a missing stack to WordPress", /isProjectStack\(row\.stack\)[\s\S]{0,80}"wordpress"/.test(repository));
check("persistence writes stack, versions, runtime", /stack: environment\.stack/.test(repository) &&
  /versions: environment\.versions/.test(repository) && /runtime: environment\.runtime/.test(repository));
check("persistence writes the deploy pipeline", /deploy_pipeline: newProject\.deployPipeline/.test(repository));

/* ------------------------------------------------------------------ */
/* 7. Migration + generated types                                      */
/* ------------------------------------------------------------------ */

const migration = read("db/migrations/20260824_multistack_projects.sql");
check("migration adds the stack column idempotently", /add column if not exists stack text/.test(migration));
check("migration adds versions and runtime", /add column if not exists versions/.test(migration) &&
  /add column if not exists runtime/.test(migration));
check("migration adds deploy_pipeline", /add column if not exists deploy_pipeline/.test(migration));
check("constraint existence check is scoped to the table",
  /conrelid = 'public\.project_environments'::regclass/.test(migration));
check("access vocabulary widens", ["server_pm2", "ci_cd", "container"].every((value) => migration.includes(`'${value}'`)));
check("task vocabulary widens", ["deploy", "migration", "feature", "dependency_upgrade"].every((value) => migration.includes(`'${value}'`)));
check("migration is non-destructive", !/drop table|drop column/i.test(migration));

const types = read("src/integrations/supabase/types.ts");
check("generated types carry the environment stack", /stack: string/.test(types));
check("generated types carry versions and runtime", /versions: Json/.test(types) && /runtime: Json \| null/.test(types));
check("generated types carry deploy_pipeline", /deploy_pipeline: Json \| null/.test(types));
check("legacy WordPress columns are nullable in types", /wordpress_version: string \| null/.test(types) &&
  /php_version: string \| null/.test(types));

/* ------------------------------------------------------------------ */
/* 8. operations.ts is untouched                                       */
/* ------------------------------------------------------------------ */

const operationsHash = createHash("sha256").update(read("src/operations.ts")).digest("hex");
check(
  "src/operations.ts is unchanged from the multi-stack base",
  operationsHash === "4fec5f5a46763461eed62f334ed39b47b1140e8028fd303f350d35b8f2b69149",
  operationsHash,
);

console.log(`\n${failures.length === 0 ? "All stack checks passed." : `${failures.length} failed.`}`);
if (failures.length > 0) process.exit(1);
