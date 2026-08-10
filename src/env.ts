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
    subdomain: env.VITE_OPS_SUBDOMAIN ?? "ops.trust-tai.com",
    supabaseUrl: env.VITE_OPS_SUPABASE_URL,
    supabasePublicKey:
      env.VITE_OPS_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_OPS_SUPABASE_ANON_KEY,
    supabaseSchema: env.VITE_OPS_SUPABASE_SCHEMA ?? "public",
  };
}

export function hasSupabasePublicConfig(env: OpsRuntimeEnv): boolean {
  return Boolean(env.supabaseUrl && env.supabasePublicKey);
}
