import type { RepositoryAdapter } from "./types";

type RuntimeEnv = Record<string, string | undefined>;

export type OpsRuntimeEnv = {
  adapter: RepositoryAdapter;
  subdomain: string;
  supabaseUrl?: string;
  supabasePublicKey?: string;
  supabaseSchema: string;
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
  };
}

export function hasSupabasePublicConfig(env: OpsRuntimeEnv): boolean {
  return Boolean(env.supabaseUrl && env.supabasePublicKey);
}
