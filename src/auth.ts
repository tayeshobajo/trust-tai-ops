import { isQaAutoLoginEnabled, resolveOpsEnv } from "./env";
import { getSupabaseClient } from "./supabase";
import type { AuthState, UserRole } from "./types";

const demoAuthState: AuthState = {
  adapter: "demo",
  isAuthenticated: true,
  userEmail: "operator@trusttai.demo",
  userId: "demo-operator",
  role: "senior_operator",
  status: "ready",
  message: "Demo operator session active. Live auth is bypassed in demo mode.",
};

function normalizeRole(raw: unknown): UserRole | null {
  if (raw === "viewer" || raw === "operator" || raw === "senior_operator" || raw === "admin") {
    return raw;
  }

  return null;
}

export async function loadAuthState(): Promise<AuthState> {
  const env = resolveOpsEnv();

  if (env.adapter === "demo") {
    return demoAuthState;
  }

  try {
    const client = getSupabaseClient();
    const [{ data: sessionData }, { data: userData, error: userError }] = await Promise.all([
      client.auth.getSession(),
      client.auth.getUser(),
    ]);

    if (userError) {
      return {
        adapter: "supabase",
        isAuthenticated: false,
        userEmail: null,
        userId: null,
        role: null,
        status: "error",
        message: `Auth lookup failed: ${userError.message}`,
      };
    }

    const user = userData.user ?? sessionData.session?.user ?? null;

    if (!user) {
      return {
        adapter: "supabase",
        isAuthenticated: false,
        userEmail: null,
        userId: null,
        role: null,
        status: "ready",
        message: "No authenticated Supabase session detected yet.",
      };
    }

    const role = normalizeRole(user.app_metadata?.role) ?? normalizeRole(user.user_metadata?.role) ?? "viewer";

    return {
      adapter: "supabase",
      isAuthenticated: true,
      userEmail: user.email ?? null,
      userId: user.id,
      role,
      status: "ready",
      message: `Signed in through Supabase as ${role}.`,
    };
  } catch (error) {
    return {
      adapter: "supabase",
      isAuthenticated: false,
      userEmail: null,
      userId: null,
      role: null,
      status: "error",
      message: error instanceof Error ? error.message : "Supabase auth failed to initialize.",
    };
  }
}

export async function signOutIfSupported(): Promise<void> {
  const env = resolveOpsEnv();

  if (env.adapter === "demo") {
    return;
  }

  const client = getSupabaseClient();
  await client.auth.signOut();
}

/**
 * Signs the shared QA account in when QA mode is enabled and no session exists.
 * No-op otherwise, so normal sign-in behaviour is untouched.
 */
export async function ensureQaSession(): Promise<void> {
  const env = resolveOpsEnv();

  if (env.adapter === "demo" || !isQaAutoLoginEnabled(env)) {
    return;
  }

  try {
    const client = getSupabaseClient();
    const { data } = await client.auth.getSession();

    if (data.session) {
      return;
    }

    const email = env.qaEmail as string;
    const password = env.qaPassword as string;

    const first = await client.auth.signInWithPassword({ email, password });

    if (!first.error) {
      return;
    }

    // Bootstrap the shared QA account server-side (create + confirm) and retry once.
    await client.functions.invoke("qa-session", { body: { email, password } });
    await client.auth.signInWithPassword({ email, password });
  } catch {
    // Fall through to the normal sign-in screen.
  }
}
