import type { RepositoryAdapter } from "./types";

type RuntimeEnv = Record<string, string | undefined>;

export type OpsRuntimeEnv = {
  adapter: RepositoryAdapter;
  subdomain: string;
  supabaseUrl?: string;
  supabasePublicKey?: string;
  supabaseSchema: string;
  /** True for a production build (`vite build` without an explicit dev mode). */
  isProductionBuild: boolean;
  /** The adapter value literally present in env, before defaulting to "auto". */
  explicitAdapter?: string;
};

function runtimeEnv(): RuntimeEnv {
  const viteEnv = import.meta.env as RuntimeEnv | undefined;
  const processEnv =
    (globalThis as { process?: { env?: RuntimeEnv } }).process?.env ?? {};

  return {
    ...processEnv,
    ...viteEnv,
  };
}

export function resolveOpsEnv(): OpsRuntimeEnv {
  const env = runtimeEnv();
  const explicitAdapter = env.VITE_OPS_REPOSITORY_ADAPTER;
  const mode = env.MODE ?? env.NODE_ENV;
  const isProductionBuild = env.PROD === true || env.PROD === "true" || mode === "production";

  return {
    adapter: (env.VITE_OPS_REPOSITORY_ADAPTER as RepositoryAdapter | undefined) ?? "auto",
    // Must match `organizations.subdomain` in the connected project, otherwise
    // the tenant lookup finds nothing even for a correctly signed-in user.
    subdomain: env.VITE_OPS_SUBDOMAIN ?? "ops.trusttai.com",
    // `VITE_OPS_*` is this app's own naming. `VITE_SUPABASE_*` is what the
    // hosting platform writes into `.env` when the Supabase project is
    // connected, so it is accepted as an equivalent public source. Both are
    // browser-safe values by definition; no server secret is read here.
    supabaseUrl: env.VITE_OPS_SUPABASE_URL ?? env.VITE_SUPABASE_URL,
    supabasePublicKey:
      env.VITE_OPS_SUPABASE_PUBLISHABLE_KEY ??
      env.VITE_OPS_SUPABASE_ANON_KEY ??
      env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      env.VITE_SUPABASE_ANON_KEY,
    supabaseSchema: env.VITE_OPS_SUPABASE_SCHEMA ?? "public",
    isProductionBuild,
    explicitAdapter,
  };
}

export function hasSupabasePublicConfig(env: OpsRuntimeEnv): boolean {
  return Boolean(env.supabaseUrl && env.supabasePublicKey);
}

/**
 * Demo data is a development affordance, never a production fallback.
 *
 * It requires an explicit `VITE_OPS_REPOSITORY_ADAPTER=demo` opt-in AND a
 * non-production build. A production bundle can therefore never silently
 * degrade into a usable demo workspace when Supabase config or auth is
 * missing — it must surface a configuration/signed-out state instead.
 */
export function isDemoModeAllowed(env: OpsRuntimeEnv = resolveOpsEnv()): boolean {
  return env.explicitAdapter === "demo" && !env.isProductionBuild;
}

/**
 * Fail closed: authentication is required unless demo mode is explicitly and
 * legitimately active. There is no build in which this returns `false` for a
 * production bundle.
 */
export function isAuthGateRequired(env: OpsRuntimeEnv = resolveOpsEnv()): boolean {
  if (env.isProductionBuild) return true;
  return !isDemoModeAllowed(env);
}

/**
 * A production build with no public Supabase config cannot serve real data and
 * must not serve fake data; the app renders an explicit configuration error.
 */
export function isMisconfiguredProduction(env: OpsRuntimeEnv = resolveOpsEnv()): boolean {
  return env.isProductionBuild && !hasSupabasePublicConfig(env);
}
