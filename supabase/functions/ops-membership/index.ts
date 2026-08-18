/**
 * Ops membership administration.
 *
 * Grants and revokes Ops access by email. Ops membership is what the SSO
 * exchange checks, so this is the surface that turns "this account does not
 * have Ops access yet" into a working sign-in.
 *
 * Every decision is made server-side:
 *  - the caller's Ops session token is re-verified against Supabase auth,
 *  - the caller's role is read from `public.users` with the service role,
 *    never from claims the browser could shape,
 *  - only an active `admin` may list, grant, or revoke.
 *
 * Revoking never deletes history: the membership row is disabled so the audit
 * trail and any work attributed to that person stay intact.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["viewer", "operator", "senior_operator", "admin"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type MemberRow = {
  id: string;
  organization_id: string;
  full_name: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
};

const MEMBER_COLUMNS = "id, organization_id, full_name, email, role, status, created_at, updated_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: "not_configured" }, 500);

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!bearer) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Identity comes from the token, verified here — never from the request body.
  const { data: caller, error: callerError } = await admin.auth.getUser(bearer);
  const callerEmail = caller?.user?.email?.trim().toLowerCase() ?? "";
  if (callerError || !caller?.user || !callerEmail) return json({ error: "unauthenticated" }, 401);

  const { data: callerMember } = await admin
    .from("users")
    .select("id, organization_id, role, status")
    .eq("email", callerEmail)
    .maybeSingle();

  if (!callerMember || callerMember.status !== "active" || callerMember.role !== "admin") {
    return json({ error: "not_an_admin" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  const organizationId = String(callerMember.organization_id);

  if (action === "list") {
    const { data, error } = await admin
      .from("users")
      .select(MEMBER_COLUMNS)
      .eq("organization_id", organizationId)
      .order("email");
    if (error) return json({ error: "list_failed", detail: error.message }, 500);
    return json({ ok: true, members: (data ?? []) as MemberRow[] });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return json({ error: "invalid_email" }, 400);

  const { data: existing } = await admin
    .from("users")
    .select(MEMBER_COLUMNS)
    .eq("email", email)
    .maybeSingle();

  if (action === "grant") {
    const role = typeof body.role === "string" && ROLES.has(body.role) ? body.role : "operator";
    const fullName =
      typeof body.fullName === "string" && body.fullName.trim().length > 0
        ? body.fullName.trim().slice(0, 120)
        : email.split("@")[0];

    if (existing && existing.organization_id !== organizationId) {
      return json({ error: "email_in_another_workspace", email }, 409);
    }

    const { data, error } = existing
      ? await admin
          .from("users")
          .update({ role, status: "active", full_name: fullName, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select(MEMBER_COLUMNS)
          .single()
      : await admin
          .from("users")
          .insert({ organization_id: organizationId, email, full_name: fullName, role, status: "active" })
          .select(MEMBER_COLUMNS)
          .single();

    if (error) return json({ error: "grant_failed", detail: error.message }, 500);
    console.log("ops_membership_granted", JSON.stringify({ email, role, by: callerEmail }));
    return json({ ok: true, member: data as MemberRow });
  }

  if (action === "revoke") {
    if (!existing || existing.organization_id !== organizationId) {
      return json({ error: "member_not_found", email }, 404);
    }
    if (existing.id === callerMember.id) return json({ error: "cannot_revoke_self", email }, 400);

    const { data, error } = await admin
      .from("users")
      .update({ status: "disabled", updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select(MEMBER_COLUMNS)
      .single();

    if (error) return json({ error: "revoke_failed", detail: error.message }, 500);

    // A disabled member must not keep elevated rights on any live session.
    const authId = await admin.auth.admin
      .listUsers({ page: 1, perPage: 200 })
      .then((res) => res.data?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null)
      .catch(() => null);
    if (authId) {
      await admin.auth.admin.updateUserById(authId, { app_metadata: { role: "viewer" } }).catch(() => null);
    }

    console.log("ops_membership_revoked", JSON.stringify({ email, by: callerEmail }));
    return json({ ok: true, member: data as MemberRow });
  }

  return json({ error: "unknown_action" }, 400);
});
