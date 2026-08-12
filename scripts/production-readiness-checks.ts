import "./hermetic-env.ts";

/**
 * Production-certification checks.
 *
 * Three failures this file exists to prevent:
 *   1. A production bundle silently serving demo data when Supabase config or
 *      auth is unavailable, which makes a broken deployment look healthy.
 *   2. Reintroduction of the retired tenant hostname `ops.trust-tai.com`,
 *      which resolves to no organization and breaks every tenant lookup.
 *   3. The auth gate being hard-disabled again in source.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const failures: string[] = [];
const check = (name: string, condition: boolean, detail = "") => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process.env;
const withEnv = async <T>(values: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> => {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = env[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
};

const envModule = await import("../src/env.ts");
const { resolveOpsEnv, isDemoModeAllowed, isAuthGateRequired, isMisconfiguredProduction } = envModule;

console.log("\nproduction builds never fall back to demo data");

await withEnv({ NODE_ENV: "production", VITE_OPS_REPOSITORY_ADAPTER: undefined }, () => {
  const production = resolveOpsEnv();
  check("a production build with no Supabase config refuses demo mode", !isDemoModeAllowed(production));
  check("and reports itself as misconfigured instead", isMisconfiguredProduction(production));
  check("and still requires authentication", isAuthGateRequired(production));
});

await withEnv({ NODE_ENV: "production", VITE_OPS_REPOSITORY_ADAPTER: "demo" }, () => {
  const forced = resolveOpsEnv();
  check("an explicit demo adapter cannot unlock demo data in production", !isDemoModeAllowed(forced));
  check("and cannot disable the production auth gate", isAuthGateRequired(forced));
});

await withEnv(
  {
    NODE_ENV: "production",
    VITE_OPS_REPOSITORY_ADAPTER: undefined,
    VITE_OPS_SUPABASE_URL: "https://example.supabase.co",
    VITE_OPS_SUPABASE_PUBLISHABLE_KEY: "public-key",
  },
  () => {
    const configured = resolveOpsEnv();
    check("a configured production build is not flagged misconfigured", !isMisconfiguredProduction(configured));
    check("but authentication is still required", isAuthGateRequired(configured));
    check("and demo data is still unreachable", !isDemoModeAllowed(configured));
  },
);

await withEnv({ NODE_ENV: "development", MODE: "development", VITE_OPS_REPOSITORY_ADAPTER: "demo" }, () => {
  const dev = resolveOpsEnv();
  check("local development can opt into demo data explicitly", isDemoModeAllowed(dev));
  check("and only then is the auth gate relaxed", !isAuthGateRequired(dev));
});

await withEnv({ NODE_ENV: "development", MODE: "development", VITE_OPS_REPOSITORY_ADAPTER: "auto" }, () => {
  const dev = resolveOpsEnv();
  check("development without an explicit demo opt-in still gates auth", isAuthGateRequired(dev));
});

console.log("\nthe auth gate cannot be hard-disabled in source");

const appSource = read("src/App.tsx");
check(
  "App does not assign a constant false to the auth gate",
  !/authGateEnabled\s*(?::\s*boolean\s*)?=\s*false/.test(appSource),
);
check(
  "the gate is derived from the fail-closed helper",
  /authGateEnabled\s*=\s*isAuthGateRequired\(/.test(appSource),
);
check("the gate still guards the workspace render", appSource.includes("if (authGateEnabled &&"));
check(
  "a failed workspace load in production surfaces an error instead of seed data",
  /if \(demoAllowed\) \{[\s\S]{0,240}createSeedWorkspace\(\)/.test(appSource) && appSource.includes("setFatalError"),
);

const envSource = read("src/env.ts");
check(
  "a production build short-circuits the gate decision to required",
  /isAuthGateRequired[\s\S]{0,240}isProductionBuild\)\s*return true/.test(envSource),
);
check(
  "demo mode requires both an explicit opt-in and a non-production build",
  /isDemoModeAllowed[\s\S]{0,200}explicitAdapter === "demo" && !env\.isProductionBuild/.test(envSource),
);

const repositorySource = read("src/repository.ts");
check(
  "the repository only reaches local persistence through the demo gate",
  /isDemoModeAllowed\(env\)\)\s*\{\s*return new LocalWorkspaceRepository\(\);/.test(repositorySource),
);
check(
  "and a production build never selects local persistence",
  /isProductionBuild\)\s*\{\s*return new SupabaseWorkspaceRepository\(\);/.test(repositorySource),
);

console.log("\nthe retired tenant hostname stays retired");

const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".lovable", "coverage"]);
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|json|sql|css|html|md|toml|example|yml|yaml)$/.test(entry)) continue;
    if (relative(root, full) === relative(root, join(root, "scripts/production-readiness-checks.ts"))) continue;
    if (readFileSync(full, "utf8").includes("ops.trust-tai.com")) offenders.push(relative(root, full));
  }
};
walk(root);
check("no source or config file references ops.trust-tai.com", offenders.length === 0, offenders.join(", "));
check("the seed tenant uses the canonical hostname", read("src/seed.ts").includes('subdomain: "ops.trusttai.com"'));
check("the default tenant subdomain is canonical", envSource.includes('"ops.trusttai.com"'));

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} production-readiness check(s) failed.`);
  process.exit(1);
}
console.log("All production-readiness checks passed.");
