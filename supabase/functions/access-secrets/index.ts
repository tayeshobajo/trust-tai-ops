// Trust Tai Ops — credential submission.
//
// One direction only. A signed-in project member may submit a WordPress
// Application Password; nobody can ever read one back. There is no GET route
// that returns a secret, and the response carries only a reference plus
// non-secret metadata.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, secretStoreDeps } from "../_shared/clients.ts";
import { secretReferenceFor, storeCredential } from "../_shared/secretStore.ts";

const fail = (code: string, summary: string, status = 200) =>
  Response.json({ ok: false, code, summary }, { status, headers: corsHeaders });

const SUPPORTED = new Set(["wordpress_admin"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("invalid_input", "Only submission is supported here.", 405);

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", "The secure credential store isn't reachable right now.");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_input", "That request could not be read.");
  }

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const accessType = typeof body.accessType === "string" ? body.accessType.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";

  if (!SUPPORTED.has(accessType)) {
    return fail("not_implemented", "That kind of access can't be stored securely yet.");
  }
  if (!username || username.length > 200) {
    return fail("invalid_input", "I need the WordPress username for that access.");
  }
  if (secret.length < 8 || secret.length > 512) {
    return fail("invalid_input", "That application password doesn't look complete.");
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) {
    const summaries: Record<string, string> = {
      unauthorized: "Please sign in before sharing access.",
      forbidden: "This account isn't allowed to add access to that project.",
      execution_context_unavailable: "I can't confirm who this project belongs to right now.",
    };
    return fail(authz.code, summaries[authz.code]);
  }

  const stored = await storeCredential(secretStoreDeps(), {
    projectId: authz.project.projectId,
    accessType,
    provider: "wordpress_application_password",
    username,
    // Application Passwords are shown with spaces; WordPress accepts either.
    secret: secret.replace(/\s+/g, ""),
  });

  if (!stored.ok) {
    return fail(stored.code, "The secure credential store isn't configured, so I did not store anything.");
  }

  return Response.json(
    {
      ok: true,
      summary: "WordPress admin access is stored securely.",
      data: {
        secretReference: secretReferenceFor(authz.project.projectId, accessType),
        accessType,
        provider: "wordpress_application_password",
        username,
        verificationState: "unverified",
      },
    },
    { headers: corsHeaders },
  );
});
