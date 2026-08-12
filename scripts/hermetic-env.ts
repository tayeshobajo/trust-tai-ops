/**
 * Test hermeticity.
 *
 * The gates exercise the local persistence adapter on purpose. If the shell
 * that runs them happens to carry the hosting platform's public Supabase
 * variables, the app would resolve a remote adapter mid-test and the checks
 * would measure the network instead of the kernel. Clearing them here — and
 * only here — keeps every gate deciding the same way on every machine.
 */

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

if (env) {
  for (const key of Object.keys(env)) {
    if (/^VITE_(OPS_)?SUPABASE_/.test(key)) delete env[key];
  }
  env.VITE_OPS_REPOSITORY_ADAPTER = "demo";
}

export {};