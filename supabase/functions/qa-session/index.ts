// Temporary QA affordance: guarantees the shared QA account exists and is
// email-confirmed so the team can use the app without a sign-in screen.
// Remove this function when auth is reintroduced.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { email, password } = await req.json();
    if (typeof email !== "string" || typeof password !== "string") {
      return json({ error: "email_and_password_required" }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    let userId: string | null = null;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "admin" },
    });

    if (created?.user) {
      userId = created.user.id;
    } else if (createError) {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existing = list?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!existing) return json({ error: "qa_user_unavailable" }, 500);
      userId = existing.id;
      await admin.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
        app_metadata: { ...(existing.app_metadata ?? {}), role: "admin" },
      });
    }

    return json({ ok: true, userId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "qa_session_failed" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
