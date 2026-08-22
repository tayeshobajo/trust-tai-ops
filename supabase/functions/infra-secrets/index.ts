// Trust Tai Ops — Org infra credential vault (Phase 4).
//
// Infra-level credentials (cPanel API tokens, DigitalOcean, Cloudflare, etc.)
// are org-scoped: one token spans projects. They live encrypted here, are
// written by authenticated org admins, and are read only by service-role code
// paths (credential resolution for Captain jobs). The browser never receives
// a ciphertext or a plaintext — list returns labels/metadata only.
//
// Identity is resolved exactly like ops-membership: bearer verified against
// Supabase auth, role read from public.users with the service role.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseEncryptionKey, sealSecret } from "../_shared/crypto.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const CREDENTIAL_TYPES = new Set([
  "cpanel_api",
  "digitalocean",
  "cloudflare",
  "godaddy_api",
  "resend",
  "stripe",
  "wpengine",
  "sftp_generic",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "not_configured" }, 500);

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!bearer) return json({ ok: false, error: "unauthenticated" }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Identity from the verified token — never from the body.
  const { data: caller, error: callerError } = await admin.auth.getUser(bearer);
  const callerEmail = caller?.user?.email?.trim().toLowerCase() ?? "";
  if (callerError || !caller?.user || !callerEmail) return json({ ok: false, error: "unauthenticated" }, 401);

  const { data: callerMember } = await admin
    .from("users")
    .select("id, organization_id, role, status")
    .eq("email", callerEmail)
    .maybeSingle();

  // Infra credentials span every project in the org — admins only.
  if (!callerMember || callerMember.status !== "active" || callerMember.role !== "admin") {
    return json({ ok: false, error: "not_an_admin" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  const organizationId = String(callerMember.organization_id);

  // ---- list (metadata only — never secret material) ----
  if (action === "list") {
    const { data, error } = await admin
      .from("org_infra_secrets")
      .select(
        "id, credential_type, label, config, verification_state, last_verified_at, created_at",
      )
      .eq("organization_id", organizationId)
      .order("credential_type");
    if (error) return json({ ok: false, error: "list_failed", detail: error.message }, 500);
    return json({ ok: true, credentials: data ?? [] });
  }

  // ---- upsert (seal + store) ----
  if (action === "upsert") {
    const credentialType = typeof body.credential_type === "string" ? body.credential_type : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const secret = typeof body.secret === "string" ? body.secret.trim() : "";
    const config =
      body.config && typeof body.config === "object" && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : {};

    if (!CREDENTIAL_TYPES.has(credentialType)) {
      return json(
        { ok: false, error: "bad_credential_type", allowed: [...CREDENTIAL_TYPES] },
        400,
      );
    }
    if (!label) return json({ ok: false, error: "missing_label" }, 400);
    if (secret.length < 8) return json({ ok: false, error: "missing_secret" }, 400);

    const keyResult = await parseEncryptionKey(Deno.env.get("AGENT_SECRET_ENCRYPTION_KEY"));
    if (!keyResult.ok) return json({ ok: false, error: keyResult.code }, 500);
    const sealed = await sealSecret(secret, keyResult.key);

    const { data: existing } = await admin
      .from("org_infra_secrets")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("credential_type", credentialType)
      .eq("label", label)
      .maybeSingle();

    const envelope = {
      organization_id: organizationId,
      credential_type: credentialType,
      label,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      algorithm: sealed.algorithm,
      key_version: sealed.keyVersion,
      config,
    };

    if (existing?.id) {
      const { error } = await admin.from("org_infra_secrets").update(envelope).eq("id", existing.id);
      if (error) return json({ ok: false, error: "update_failed", detail: error.message }, 500);
      return json({ ok: true, id: existing.id, updated: true });
    }

    const { data: inserted, error } = await admin
      .from("org_infra_secrets")
      .insert(envelope)
      .select("id")
      .single();
    if (error) return json({ ok: false, error: "insert_failed", detail: error.message }, 500);
    return json({ ok: true, id: inserted.id, updated: false });
  }

  // ---- delete ----
  if (action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return json({ ok: false, error: "missing_id" }, 400);
    const { error } = await admin
      .from("org_infra_secrets")
      .delete()
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (error) return json({ ok: false, error: "delete_failed", detail: error.message }, 500);
    return json({ ok: true });
  }

  // ---- verify (manual ack for now) ----
  if (action === "verify") {
    const id = typeof body.id === "string" ? body.id : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!id) return json({ ok: false, error: "missing_id" }, 400);
    if (state !== "verified" && state !== "rejected" && state !== "unverified") {
      return json({ ok: false, error: "bad_state" }, 400);
    }
    const { error } = await admin
      .from("org_infra_secrets")
      .update({
        verification_state: state,
        last_verified_at: state === "verified" ? new Date().toISOString() : null,
      })
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (error) return json({ ok: false, error: "verify_failed", detail: error.message }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
