import { createClient } from "@supabase/supabase-js";
import { hasSupabasePublicConfig, resolveOpsEnv } from "./env";

let client: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  if (client) {
    return client;
  }

  const env = resolveOpsEnv();

  if (!hasSupabasePublicConfig(env)) {
    throw new Error(
      "Missing VITE_OPS_SUPABASE_URL and VITE_OPS_SUPABASE_PUBLISHABLE_KEY (or VITE_OPS_SUPABASE_ANON_KEY).",
    );
  }

  client = createClient(env.supabaseUrl!, env.supabasePublicKey!, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  return client;
}
