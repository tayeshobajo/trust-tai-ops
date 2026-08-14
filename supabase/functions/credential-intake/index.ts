// Trust Tai Ops — chat-native secure credential intake.
//
// A person can paste access details straight into a project Conversation. That
// text never becomes a stored message: it is posted here first, parsed and
// authorized server-side, and only a sanitized structured result comes back.
//
// The browser supplies a project id, the raw composer text, and an idempotency
// key. Nothing else. It cannot name an organization, a target URL, an access
// type, a provider, a credential reference or a verification state.
//
// Nothing secret is ever returned, logged, or written outside the encrypted
// `project_access_secrets` store.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, secretStoreDeps, serviceClient, stackDeps } from "../_shared/clients.ts";
import { effectiveStack } from "../_shared/stackGuard.ts";
import { secretReferenceFor, storeCredential } from "../_shared/secretStore.ts";
import { verifyStoredWordPressCredential } from "../_shared/verification.ts";
import { verifyWordPressLogin } from "../_shared/wpLogin.ts";
import { validatePrivateKey, validateSshDestination, validateSshUsername } from "../_shared/sshSafety.ts";
import {
  accessLabel,
  hostOf,
  parseCredentialText,
  providerLabel,
  redactSecrets,
  sameSite,
  sanitizedIntakeMessage,
  type CredentialProvider,
  type IntakeAccessType,
  type ParsedBundle,
} from "../_shared/credentialText.ts";

const fail = (code: string, summary: string, status = 200) =>
  Response.json({ ok: false, code, summary }, { status, headers: corsHeaders });

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "Please sign in before sharing access.",
  forbidden: "This account isn't allowed to manage access for that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now.",
};

type StoredOutcome = {
  accessType: IntakeAccessType;
  provider: CredentialProvider;
  /** Safe, human-readable mode label. Never secret material. */
  mode: string;
  verification: "verified" | "rejected" | "unverified" | "needs_attention" | "unsupported";
  note: string;
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
  const text = typeof body.text === "string" ? body.text : "";
  const intakeKey = typeof body.intakeKey === "string" ? body.intakeKey.trim().slice(0, 120) : "";

  if (!intakeKey) return fail("invalid_input", "That submission is missing its idempotency key.");
  if (!text.trim() || text.length > 20_000) return fail("invalid_input", "That message is empty or too long to read.");

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code]);

  // The server repeats the classification. Client detection is UX only.
  const parsed = parseCredentialText(text);
  if (!parsed.containsSecrets) {
    return fail("no_credentials", "That message doesn't contain credentials, so it belongs in the normal conversation.");
  }

  const service = serviceClient();
  const project = authz.project;

  // -- server-resolved domain truth -----------------------------------------
  const canonicalHosts = new Set<string>();
  if (project.primaryDomain) canonicalHosts.add(project.primaryDomain.toLowerCase().replace(/^www\./, ""));
  if (project.canonicalUrl) {
    const host = hostOf(project.canonicalUrl);
    if (host) canonicalHosts.add(host);
  }
  try {
    const { data } = await service
      .from("project_environments")
      .select("primary_url")
      .eq("project_id", project.projectId);
    for (const row of (data ?? []) as Array<{ primary_url?: string | null }>) {
      const host = hostOf(String(row.primary_url ?? ""));
      if (host) canonicalHosts.add(host);
    }
  } catch {
    // Falls back to the project's own domain, which is already trusted.
  }

  const belongsHere = (candidate: string): boolean =>
    [...canonicalHosts].some((known) => sameSite(candidate, known));

  const claimedSiteHost = (() => {
    for (const bundle of parsed.bundles) {
      const candidate = hostOf(bundle.siteUrl ?? "") || hostOf(bundle.adminUrl ?? "");
      if (candidate) return candidate;
    }
    for (const url of parsed.urls) {
      const candidate = hostOf(url);
      if (candidate) return candidate;
    }
    return "";
  })();

  if (claimedSiteHost && canonicalHosts.size > 0 && !belongsHere(claimedSiteHost)) {
    // Nothing is stored and nothing raw is persisted.
    return Response.json(
      {
        ok: false,
        code: "domain_mismatch",
        summary: "These credentials appear to belong to another site. I didn't attach them to this project.",
        data: {
          site: [...canonicalHosts][0] ?? "",
          storedCount: 0,
          message: [
            "These credentials appear to belong to another site, so I didn't attach them to this project.",
            "Open or create the project for that site and send them there.",
          ],
        },
      },
      { headers: corsHeaders },
    );
  }

  // -- stack truth -----------------------------------------------------------
  let stack: string = "wordpress";
  try {
    stack = effectiveStack(await stackDeps().loadEnvironmentStacks(project.projectId));
  } catch {
    return fail("execution_context_unavailable", "I can't confirm what this project runs on right now, so I stopped.");
  }

  const deps = secretStoreDeps();
  const stored: StoredOutcome[] = [];
  const rejectedBundles: Array<{ accessType: IntakeAccessType; reason: string }> = [];

  const persistAccessMethod = async (
    accessType: IntakeAccessType,
    label: string,
    authMethod: string,
    notes: string,
    verifiedAt: string | null,
  ) => {
    try {
      const { data } = await service
        .from("project_access_methods")
        .select("id")
        .eq("project_id", project.projectId)
        .eq("access_type", accessType)
        .maybeSingle();

      const patch = {
        project_id: project.projectId,
        access_type: accessType,
        label,
        status: "available",
        auth_method: authMethod,
        credential_reference: secretReferenceFor(project.projectId, accessType),
        last_verified_at: verifiedAt,
        notes,
        updated_at: new Date().toISOString(),
      };

      if (data?.id) {
        await service.from("project_access_methods").update(patch).eq("id", data.id);
      } else {
        await service.from("project_access_methods").insert(patch);
      }
    } catch {
      // Access metadata is a projection of the secret store, which already
      // succeeded. A failure here never invents a different truth.
    }
  };

  const audit = async (accessType: string, provider: string, action: string, detail: Record<string, unknown>) => {
    try {
      await service.from("project_events").insert({
        project_id: project.projectId,
        event_key: `credential-intake:${intakeKey}:${accessType}:${action}`,
        event_type: "credential_intake",
        actor_user_id: null,
        summary: `${accessType} ${action}`,
        // Safe facts only: never a secret, a header, a cookie or raw input.
        detail: { accessType, provider, action, ...detail },
      });
    } catch {
      // A duplicate key is the idempotent case and is meant to be ignored.
    }
  };

  for (const bundle of parsed.bundles) {
    if (bundle.accessType === "wordpress_admin") {
      if (stack !== "wordpress") {
        rejectedBundles.push({
          accessType: bundle.accessType,
          reason: "This project doesn't run WordPress, so I didn't store WordPress admin details for it.",
        });
        continue;
      }
      await storeWordPress(bundle);
      continue;
    }
    if (bundle.accessType === "ftp") {
      // No maintained, safe plain-FTP transport exists in this runtime, and the
      // credential store has no honest slot for it. Refusing beats pretending.
      rejectedBundles.push({
        accessType: "ftp",
        reason:
          "This deployment can't store or verify plain FTP yet. SFTP or SSH on the same server works, if the host offers it.",
      });
      continue;
    }
    await storeServerAccess(bundle);
  }

  async function storeWordPress(bundle: ParsedBundle) {
    const isAppPassword = bundle.provider === "wordpress_application_password";
    const secret = isAppPassword ? bundle.secret.replace(/\s+/g, "") : bundle.secret;
    if (secret.length < 6 || secret.length > 512 || !bundle.username || bundle.username.length > 200) {
      rejectedBundles.push({ accessType: "wordpress_admin", reason: "Those WordPress details didn't look complete." });
      return;
    }

    const result = await storeCredential(deps, {
      projectId: project.projectId,
      accessType: "wordpress_admin",
      provider: bundle.provider,
      username: bundle.username,
      secret,
      config: { mode: isAppPassword ? "application_password" : "login_password" },
    });
    if (!result.ok) {
      rejectedBundles.push({
        accessType: "wordpress_admin",
        reason: "The secure credential store isn't configured, so I did not store anything.",
      });
      return;
    }

    // Verification is a separate fact from storage, and it is decided here.
    let verification: StoredOutcome["verification"] = "unverified";
    let note = "Stored securely. Not yet verified.";
    let verifiedAt: string | null = null;

    if (isAppPassword) {
      const outcome = await verifyStoredWordPressCredential(deps, project.projectId, project.canonicalUrl);
      verification = outcome.state;
      verifiedAt = outcome.lastVerifiedAt;
      note = outcome.summary;
    } else {
      const outcome = await verifyWordPressLogin(project.canonicalUrl, {
        username: bundle.username,
        password: secret,
      });
      verification = outcome.state;
      note =
        outcome.state === "verified"
          ? "WordPress Admin login is verified. This is a normal login password, not an Application Password, so the private REST inspection path is not enabled from this credential."
          : outcome.summary;
      if (outcome.state === "verified") {
        verifiedAt = new Date().toISOString();
        await deps.markVerification?.(project.projectId, "wordpress_admin", "verified", verifiedAt);
      } else if (outcome.state === "rejected") {
        await deps.markVerification?.(project.projectId, "wordpress_admin", "rejected", null);
      }
    }

    await persistAccessMethod(
      "wordpress_admin",
      "WordPress Admin",
      isAppPassword ? "Application Password" : "Login password",
      `Shared in conversation as a ${providerLabel(bundle.provider)}.`,
      verifiedAt,
    );
    await audit("wordpress_admin", bundle.provider, verification === "verified" ? "verified" : "stored", {
      verification,
    });

    stored.push({
      accessType: "wordpress_admin",
      provider: bundle.provider,
      mode: isAppPassword ? "Application Password" : "Login password",
      verification,
      note,
    });
  }

  async function storeServerAccess(bundle: ParsedBundle) {
    const accessType: IntakeAccessType = bundle.accessType === "ssh" ? "ssh" : "sftp";
    const user = validateSshUsername(bundle.username);
    if (!user.ok) {
      rejectedBundles.push({ accessType, reason: user.reason });
      return;
    }
    const destination = validateSshDestination(bundle.host ?? "", bundle.port);
    if (!destination.ok) {
      rejectedBundles.push({ accessType, reason: destination.reason });
      return;
    }

    const keyBased = bundle.provider === "ssh_private_key";
    let payload: string;
    if (keyBased) {
      const key = validatePrivateKey(bundle.secret);
      if (!key.ok) {
        rejectedBundles.push({ accessType, reason: key.reason });
        return;
      }
      payload = JSON.stringify({ privateKey: key.key, passphrase: bundle.passphrase || undefined });
    } else {
      if (bundle.secret.length < 6 || bundle.secret.length > 512) {
        rejectedBundles.push({ accessType, reason: "That password didn't look complete." });
        return;
      }
      payload = JSON.stringify({ password: bundle.secret });
    }

    const result = await storeCredential(deps, {
      projectId: project.projectId,
      accessType,
      provider: keyBased ? "ssh_private_key" : "sftp_password",
      username: user.username,
      secret: payload,
      config: {
        host: destination.host,
        port: destination.port,
        mode: keyBased ? "private_key" : "password",
      },
    });
    if (!result.ok) {
      rejectedBundles.push({
        accessType,
        reason: "The secure credential store isn't configured, so I did not store anything.",
      });
      return;
    }

    await persistAccessMethod(
      accessType,
      accessType === "ssh" ? "SSH" : "SFTP",
      keyBased ? "Private key" : "Password",
      `Shared in conversation for ${destination.host}.`,
      null,
    );
    await audit(accessType, keyBased ? "ssh_private_key" : "sftp_password", "stored", { verification: "unverified" });

    stored.push({
      accessType,
      provider: keyBased ? "ssh_private_key" : "sftp_password",
      mode: keyBased ? "Private key" : "Password",
      // Only key-based access has a maintained server-side verifier here.
      verification: keyBased ? "unverified" : "unsupported",
      note: keyBased
        ? "Stored securely. I haven't connected yet — checking it will also record the server's identity."
        : "Stored securely, but this deployment verifies server access with a key, not a password, so I can't confirm it yet.",
    });
  }

  const site = [...canonicalHosts][0] ?? "";
  const effectiveMissing = parsed.missing.filter(
    (gap) => !stored.some((item) => item.accessType === gap.accessType),
  );
  const message = sanitizedIntakeMessage({
    site,
    stored: stored.map((item) => ({ accessType: item.accessType, provider: item.provider })),
    missing: effectiveMissing,
    intent: parsed.intent,
    sawSecretMaterial: parsed.containsSecrets && stored.length === 0 && effectiveMissing.length === 0,
  });

  const reply: string[] = [];
  if (stored.length === 0 && effectiveMissing.length === 0 && rejectedBundles.length === 0) {
    reply.push(
      "I can see credential-shaped text, but I couldn't match it to a complete access bundle. Try the Access & Connections panel, or paste each access type with clear labels like 'Username:' and 'Password:'.",
    );
  } else {
    for (const item of stored) {
      // The mode is written in brackets, never as "…password: …". A label word
      // followed by a colon looks exactly like a pasted secret to the
      // scrubber, and the agent's own safe sentence was being redacted away.
      reply.push(`${accessLabel(item.accessType)} (${item.mode}) — ${item.note}`);
    }
    for (const gap of effectiveMissing) {
      if (rejectedBundles.some((item) => item.accessType === gap.accessType)) continue;
      reply.push(
        `${accessLabel(gap.accessType)} access still needs ${gap.fields.join(", ")}. I won't guess it from the website or the WordPress login.`,
      );
    }
    for (const item of rejectedBundles) reply.push(`${accessLabel(item.accessType)}: ${item.reason}`);
  }
  reply.push("Nothing was changed on the site. Send me the issue whenever you're ready.");

  return Response.json(
    {
      ok: true,
      code: null,
      summary: "Credentials shared securely.",
      data: {
        site,
        // Sanitized through the redactor once more, as a last net.
        message: message.map((line) => redactSecrets(line)),
        reply: reply.map((line) => redactSecrets(line)),
        stored: stored.map((item) => ({
          accessType: item.accessType,
          provider: item.provider,
          mode: item.mode,
          verification: item.verification,
        })),
        missing: parsed.missing
          .filter((gap) => !stored.some((item) => item.accessType === gap.accessType))
          .map((gap) => ({ accessType: gap.accessType, fields: gap.fields })),
      },
    },
    { headers: corsHeaders },
  );
});
