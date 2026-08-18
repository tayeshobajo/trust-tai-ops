/**
 * Trust Tai OS -> Ops SSO exchange.
 *
 * The browser hands this function a Trust Tai OS access token that arrived by
 * postMessage from an exactly-matched OS origin. Nothing about that token is
 * trusted here: it is re-verified against the Trust Tai OS auth service before
 * any identity decision is made. Decoded JWT claims from the browser are never
 * used.
 *
 * What comes back is a single-use Supabase email OTP `token_hash` for the
 * matching Ops account. The browser completes the sign-in through the normal
 * Supabase client. No service-role key, password, or long-lived secret is ever
 * returned.
 *
 * Required Edge Function secrets:
 *   TRUST_TAI_OS_SUPABASE_URL       https://okydosoacqdnursmmenf.supabase.co
 *   TRUST_TAI_OS_SUPABASE_ANON_KEY  the OS project's browser-safe anon key
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/**
 * Verifies the OS token against the OS auth service. Expired, revoked, or
 * forged tokens fail here, not later.
 */
async function verifyOsToken(token: string): Promise<{ id: string; email: string } | null> {
  const osUrl = Deno.env.get("TRUST_TAI_OS_SUPABASE_URL") ?? "";
  const osAnon = Deno.env.get("TRUST_TAI_OS_SUPABASE_ANON_KEY") ?? "";
  if (!osUrl || !osAnon) throw new Error("os_not_configured");

  const response = await fetch(`${osUrl.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: { apikey: osAnon, Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string; email?: string; aud?: string };
  if (!user?.id || !user.email) return null;

  return { id: String(user.id), email: String(user.email).toLowerCase() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let osAccessToken = "";
  let canonicalProjectId: string | null = null;
  let osOrganizationId: string | null = null;

  try {
    const body = await req.json();
    if (typeof body?.osAccessToken !== "string" || !JWT_SHAPE.test(body.osAccessToken)) {
      return json({ error: "invalid_os_token" }, 400);
    }
    osAccessToken = body.osAccessToken;

    // Context only. It is validated for shape and echoed back, but it is
    // never allowed to stand in for token verification or to widen access.
    if (typeof body?.osOrganizationId === "string" && body.osOrganizationId.length > 0) {
      if (!UUID.test(body.osOrganizationId)) return json({ error: "invalid_os_organization_id" }, 400);
      osOrganizationId = body.osOrganizationId.toLowerCase();
    }

    if (typeof body?.canonicalProjectId === "string" && body.canonicalProjectId.length > 0) {
      if (!UUID.test(body.canonicalProjectId)) return json({ error: "invalid_canonical_project_id" }, 400);
      canonicalProjectId = body.canonicalProjectId.toLowerCase();
    }

    const osUser = await verifyOsToken(osAccessToken);
    if (!osUser) {
      console.log("sso_refused os_token_rejected");
      return json({ error: "os_token_rejected" }, 401);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Exact identity resolution only: persisted external reference first,
    // then exact verified email. Never a fuzzy or partial match.
    let member: Record<string, unknown> | null = null;

    const byExternal = await admin
      .from("users")
      .select("id, organization_id, email, role, status, auth_user_id, trust_tai_os_user_id")
      .eq("trust_tai_os_user_id", osUser.id)
      .maybeSingle();
    member = byExternal.data ?? null;

    if (!member) {
      const normalizedEmail = osUser.email.trim().toLowerCase();
      const byEmail = await admin
        .from("users")
        .select("id, organization_id, email, role, status, auth_user_id, trust_tai_os_user_id")
        .eq("email", normalizedEmail)
        .maybeSingle();
      member = byEmail.data ?? null;
    }

    if (!member) {
      // Identity only, never the token: a 403 is unactionable without knowing
      // who was turned away.
      console.log("sso_refused no_ops_membership", JSON.stringify({ email: osUser.email, osUserId: osUser.id }));
      return json({ error: "no_ops_membership", email: osUser.email }, 403);
    }
    if (member.status === "disabled") {
      console.log("sso_refused ops_access_disabled", JSON.stringify({ email: osUser.email, osUserId: osUser.id }));
      return json({ error: "ops_access_disabled", email: osUser.email }, 403);
    }

    const opsRole = String(member.role ?? "viewer");
    const email = String(member.email ?? osUser.email).toLowerCase();

    // Ensure a local auth account exists. Provisioning happens only here, with
    // the local service role, and only for someone who already holds Ops
    // membership. Ops roles are untouched by the OS: OS entitlement says
    // whether you may enter, Ops role says what you may do.
    let authUserId = member.auth_user_id ? String(member.auth_user_id) : null;

    if (!authUserId) {
      const created = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        app_metadata: { role: opsRole, provisioned_by: "trust_tai_os_sso" },
      });

      if (created.data?.user) {
        authUserId = created.data.user.id;
      } else {
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const existing = list?.users?.find((u) => u.email?.toLowerCase() === email);
        if (!existing) return json({ error: "ops_account_unavailable" }, 500);
        authUserId = existing.id;
      }
    }

    await admin.auth.admin.updateUserById(authUserId, {
      app_metadata: { role: opsRole },
    });

    await admin
      .from("users")
      .update({ auth_user_id: authUserId, trust_tai_os_user_id: osUser.id })
      .eq("id", member.id);

    // Server-to-client session bootstrap: a single-use OTP hash the browser
    // redeems through the normal Supabase client. No password, no service key.
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

    const tokenHash = link?.properties?.hashed_token;
    if (linkError || !tokenHash) {
      console.log("sso_failed session_bootstrap_failed", JSON.stringify({ email }));
      return json({ error: "session_bootstrap_failed", email }, 500);
    }

    return json({
      ok: true,
      email,
      tokenHash,
      opsUserId: String(member.id),
      organizationId: String(member.organization_id),
      role: opsRole,
      osUserId: osUser.id,
      osOrganizationId,
      canonicalProjectId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "sso_exchange_failed";
    return json({ error: message === "os_not_configured" ? "os_not_configured" : "sso_exchange_failed" }, 500);
  } finally {
    osAccessToken = "";
  }
});