// Trust Tai Ops — credential submission and verification.
//
// One direction only. A signed-in project member may submit a WordPress
// Application Password; nobody can ever read one back. There is no GET route
// that returns a secret, and the response carries only a reference plus
// non-secret metadata.
//
// `mode: "verify"` proves a stored credential against the project's own
// canonical WordPress origin. The browser supplies a project id and nothing
// else — no URL, no username, no secret — so it cannot aim the check anywhere.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, secretStoreDeps } from "../_shared/clients.ts";
import { secretReferenceFor, storeCredential } from "../_shared/secretStore.ts";
import { verifyStoredWordPressCredential } from "../_shared/verification.ts";
import { runReadOnlyWpCli } from "../_shared/wpCli.ts";
import { denoSshTransport } from "../_shared/sshTransport.ts";
import { validatePrivateKey, validateSshDestination, validateSshUsername } from "../_shared/sshSafety.ts";
import { validateWpBinary, validateWpRoot } from "../_shared/wpCliCatalog.ts";

const fail = (code: string, summary: string, status = 200) =>
  Response.json({ ok: false, code, summary }, { status, headers: corsHeaders });

const SUPPORTED = new Set(["wordpress_admin", "ssh", "sftp", "google_search_console"]);

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "Please sign in before sharing access.",
  forbidden: "This account isn't allowed to manage access for that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now.",
};

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
  const mode = body.mode === "verify" ? "verify" : body.mode === "details" ? "details" : "store";

  if (!SUPPORTED.has(accessType)) {
    return fail("not_implemented", "That kind of access can't be stored securely yet.");
  }

  // --- Non-secret details --------------------------------------------------
  //
  // Everything a person typed that is *not* a credential, so replacing access
  // doesn't mean retyping it. No ciphertext, no plaintext, ever.
  if (mode === "details") {
    const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
    if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code]);

    let row: Awaited<ReturnType<ReturnType<typeof secretStoreDeps>["loadRow"]>> = null;
    try {
      row = await secretStoreDeps().loadRow(authz.project.projectId, accessType);
    } catch {
      row = null;
    }

    const config = (row?.config ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");

    return Response.json(
      {
        ok: true,
        summary: row ? "Stored connection details." : "Nothing stored for that connection yet.",
        data: {
          accessType,
          exists: Boolean(row),
          provider: row?.provider ?? "",
          username: row?.username ?? "",
          details: {
            host: text("host"),
            port: typeof config.port === "number" ? String(config.port) : text("port"),
            wpRoot: text("wpRoot"),
            wpBinary: text("wpBinary"),
            loginUrl: text("loginUrl"),
          },
        },
      },
      { headers: corsHeaders },
    );
  }

  // --- SSH -----------------------------------------------------------------
  //
  // SSH is stored as a sealed JSON payload holding only secret material. The
  // host, port and paths are non-secret connection details and live beside it.
  if (accessType === "ssh" || accessType === "sftp") {
    const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
    if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code]);

    if (mode === "verify") {
      // The one place a first host identity may be recorded: a person asked
      // for this check, so trust-on-first-use is bounded and deliberate.
      const outcome = await runReadOnlyWpCli(secretStoreDeps(), denoSshTransport(), {
        projectId: authz.project.projectId,
        commandId: "core.is_installed",
        allowFirstUse: true,
      });

      return Response.json(
        {
          ok: outcome.ok,
          code: outcome.ok ? null : outcome.code,
          summary: outcome.ok
            ? "The server accepted that sign-in and WordPress answered. I recorded the server's identity."
            : outcome.summary,
          data: {
            accessType,
            verificationState: outcome.ok ? "verified" : outcome.code === "auth_failed" ? "rejected" : "unverified",
            lastVerifiedAt: outcome.ok ? new Date().toISOString() : null,
          },
        },
        { headers: corsHeaders },
      );
    }

    if (accessType === "sftp") {
      // Password-based SFTP arrives through secure chat intake, which parses
      // the host, port, username and password together.
      return fail(
        "not_implemented",
        "Send SFTP details in the project conversation — I'll store them securely from there.",
      );
    }

    const user = validateSshUsername(username);
    if (!user.ok) return fail("invalid_input", user.reason);

    const destination = validateSshDestination(
      typeof body.host === "string" ? body.host : "",
      body.port,
    );
    if (!destination.ok) return fail("invalid_input", destination.reason);

    const key = validatePrivateKey(secret);
    if (!key.ok) return fail("invalid_input", key.reason);

    const root = validateWpRoot(typeof body.wpRoot === "string" ? body.wpRoot : null);
    if (!root.ok) return fail("invalid_input", root.reason);

    const binary = validateWpBinary(typeof body.wpBinary === "string" ? body.wpBinary : null);
    if (!binary.ok) return fail("invalid_input", binary.reason);

    const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
    if (passphrase.length > 512) return fail("invalid_input", "That key passphrase is too long.");

    let storedSsh: Awaited<ReturnType<typeof storeCredential>>;
    try {
      storedSsh = await storeCredential(secretStoreDeps(), {
        projectId: authz.project.projectId,
        accessType,
        provider: "ssh_private_key",
        username: user.username,
        secret: JSON.stringify({ privateKey: key.key, passphrase: passphrase || undefined }),
        config: {
          host: destination.host,
          port: destination.port,
          wpRoot: root.path,
          wpBinary: binary.binary,
        },
      });
    } catch {
      // A storage failure must answer in the contract's shape, never as a 500.
      return fail("secret_store_unavailable", "I couldn't store that access just now, so nothing was saved.");
    }

    if (!storedSsh.ok) {
      return fail(storedSsh.code, "The secure credential store isn't configured, so I did not store anything.");
    }

    return Response.json(
      {
        ok: true,
        summary:
          "SSH access is stored securely. I haven't connected yet — checking it will also record the server's identity.",
        data: {
          secretReference: secretReferenceFor(authz.project.projectId, accessType),
          accessType,
          provider: "ssh_private_key",
          username: user.username,
          verificationState: "unverified",
          lastVerifiedAt: null,
        },
      },
      { headers: corsHeaders },
    );
  }

  // --- Google Search Console -------------------------------------------
  //
  // The credential is a Google service account JSON key. The entire JSON blob
  // is sealed as the secret; the service account email is the username.
  if (accessType === "google_search_console") {
    const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
    if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code]);

    if (mode === "verify") {
      // Verification requires a live GSC API call; not yet implemented.
      return fail(
        "not_implemented",
        "Live Search Console verification isn't available yet. The agent will confirm access on its first run.",
      );
    }

    if (mode === "details") {
      // Already handled by the top-level details branch above; belt-and-suspenders.
      return fail("invalid_input", "That request could not be read.");
    }

    // store mode
    if (!secret.trim().startsWith("{") || secret.length < 100 || !secret.includes('"private_key"')) {
      return fail(
        "invalid_input",
        "Paste the whole service account JSON key file. Download it from Google Cloud Console → Service Accounts → Keys.",
      );
    }
    if (!username || username.length > 200) {
      return fail("invalid_input", "I need the service account email address for that access.");
    }

    let storedGsc: Awaited<ReturnType<typeof storeCredential>>;
    try {
      storedGsc = await storeCredential(secretStoreDeps(), {
        projectId: authz.project.projectId,
        accessType: "google_search_console",
        provider: "google_service_account",
        username,
        secret: secret.trim(),
        config: { mode: "service_account" },
      });
    } catch {
      return fail("secret_store_unavailable", "I couldn't store that access just now, so nothing was saved.");
    }

    if (!storedGsc.ok) {
      return fail(storedGsc.code, "The secure credential store isn't configured, so I did not store anything.");
    }

    return Response.json(
      {
        ok: true,
        summary: "Google Search Console service account is stored securely. The agent will confirm data access on its first run.",
        data: {
          secretReference: secretReferenceFor(authz.project.projectId, "google_search_console"),
          accessType: "google_search_console",
          provider: "google_service_account",
          username,
          verificationState: "unverified",
          lastVerifiedAt: null,
        },
      },
      { headers: corsHeaders },
    );
  }

  if (mode === "verify") {
    const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
    if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code]);

    const outcome = await verifyStoredWordPressCredential(
      secretStoreDeps(),
      authz.project.projectId,
      // Server-resolved. An address from the browser is never accepted here.
      authz.project.canonicalUrl,
    );

    return Response.json(
      {
        ok: outcome.state === "verified",
        code: outcome.code,
        summary: outcome.summary,
        data: {
          accessType,
          verificationState: outcome.state,
          lastVerifiedAt: outcome.lastVerifiedAt,
        },
      },
      { headers: corsHeaders },
    );
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

  // A custom admin address is a non-secret hint, kept only when it points at
  // the project's own site.
  const rawLoginUrl = typeof body.loginUrl === "string" ? body.loginUrl.trim().slice(0, 500) : "";
  let loginUrl = "";
  if (rawLoginUrl && authz.project.canonicalUrl) {
    try {
      const origin = new URL(authz.project.canonicalUrl).origin;
      const parsed = new URL(rawLoginUrl, origin);
      if (parsed.origin === origin) loginUrl = `${parsed.pathname}${parsed.search}`;
    } catch {
      loginUrl = "";
    }
  }

  let stored: Awaited<ReturnType<typeof storeCredential>>;
  try {
    stored = await storeCredential(secretStoreDeps(), {
      projectId: authz.project.projectId,
      accessType,
      provider: "wordpress_application_password",
      username,
      // Application Passwords are shown with spaces; WordPress accepts either.
      secret: secret.replace(/\s+/g, ""),
      config: loginUrl ? { loginUrl } : {},
    });
  } catch {
    return fail("secret_store_unavailable", "I couldn't store that access just now, so nothing was saved.");
  }

  if (!stored.ok) {
    return fail(stored.code, "The secure credential store isn't configured, so I did not store anything.");
  }

  return Response.json(
    {
      ok: true,
      // Stored is not verified. The wording says exactly what happened.
      summary: "WordPress admin access is stored securely. It hasn't been checked with WordPress yet.",
      data: {
        secretReference: secretReferenceFor(authz.project.projectId, accessType),
        accessType,
        provider: "wordpress_application_password",
        username,
        verificationState: "unverified",
        lastVerifiedAt: null,
      },
    },
    { headers: corsHeaders },
  );
});
