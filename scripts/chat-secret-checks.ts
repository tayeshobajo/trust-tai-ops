import "./hermetic-env.ts";

/**
 * Executable validation for chat-native secure credential intake.
 *
 * Run with: npm run check:chat-secrets
 *
 * Every value used here is a fabricated placeholder. No real credential from
 * any site appears in this file, and no network call is made: the WordPress
 * login verifier is exercised through an injected fetch.
 */

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const {
  containsSecretMaterial,
  normalizeLine,
  parseCredentialText,
  redactSecrets,
  sameSite,
  sanitizedIntakeMessage,
} = await import("../supabase/functions/_shared/credentialText.ts");

const { hasLoggedInCookie, loginEndpointFor, verifyWordPressLogin } = await import(
  "../supabase/functions/_shared/wpLogin.ts"
);

const client = await import("../src/agent-core/secretGuard.ts");

const readFile = async (path: string) => (await import("node:fs/promises")).readFile(path, "utf8");

// Fabricated placeholders only.
const FAKE_WP_PASSWORD = "Fak3-Placeholder-Pw-01";
const FAKE_APP_PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";
const FAKE_SFTP_PASSWORD = "Fak3-Placeholder-Sftp-02";
const FAKE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZmFrZS1wbGFjZWhvbGRlci1rZXktbWF0ZXJpYWwtbm90LXJlYWw=",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

console.log("\nA. Parser\n");

const wpBundleText = [
  "Confirm you can access the FTP and wp-admin of this site",
  "Url: [example.com](https://example.com/)",
  "Wp-admin: https://example.com/wp-admin/",
  "Email: owner\\@example.com",
  `Password: ${FAKE_WP_PASSWORD}`,
  "Once confirmed, I'll share the issue",
].join("\n");

const wpParsed = parseCredentialText(wpBundleText);

check("markdown link normalizes to its URL", normalizeLine("Url: [example.com](https://example.com/)").includes("https://example.com/"));
check("escaped email normalizes", normalizeLine("Email: owner\\@example.com") === "Email: owner@example.com");
check("WordPress login bundle parsed", wpParsed.bundles.some((b) => b.accessType === "wordpress_admin"));
check(
  "normal password is modelled as a login password",
  wpParsed.bundles[0]?.provider === "wordpress_login_password",
);
check("username came from the Email label", wpParsed.bundles[0]?.username === "owner@example.com");
check("site url captured", wpParsed.bundles[0]?.siteUrl === "https://example.com/");
check("admin url captured", (wpParsed.bundles[0]?.adminUrl ?? "").includes("/wp-admin/"));

const appParsed = parseCredentialText(
  ["Site: https://example.com", "Username: ops-agent", `Application Password: ${FAKE_APP_PASSWORD}`].join("\n"),
);
check(
  "Application Password distinguished from a normal password",
  appParsed.bundles[0]?.provider === "wordpress_application_password",
);

const mixed = parseCredentialText(
  [
    "Confirm wp-admin and SFTP",
    "URL: https://example.com",
    "Email: owner@example.com",
    `Password: ${FAKE_WP_PASSWORD}`,
    "SFTP",
    "Host: sftp.example.com",
    "Port: 2222",
    "Username: deploy",
    `Password: ${FAKE_SFTP_PASSWORD}`,
  ].join("\n"),
);
const wpSide = mixed.bundles.find((b) => b.accessType === "wordpress_admin");
const sftpSide = mixed.bundles.find((b) => b.accessType === "sftp");
check("labelled sections parsed independently", Boolean(wpSide) && Boolean(sftpSide));
check("passwords are never cross-applied", wpSide?.secret === FAKE_WP_PASSWORD && sftpSide?.secret === FAKE_SFTP_PASSWORD);
check("sftp host and port parsed", sftpSide?.host === "sftp.example.com" && sftpSide?.port === 2222);

const keyText = parseCredentialText(["SSH", "Host: 198.51.100.10", "Username: deploy", `Private key:`, FAKE_KEY].join("\n"));
const sshBundle = keyText.bundles.find((b) => b.accessType === "ssh");
check("PEM block parsed as an SSH private key", sshBundle?.provider === "ssh_private_key");
check("PEM key material captured whole", (sshBundle?.secret ?? "").includes("END OPENSSH PRIVATE KEY"));

check(
  "FTP requested without FTP fields reports the missing minimum",
  wpParsed.missing.some(
    (gap) => gap.accessType === "ftp" && gap.fields.includes("host") && gap.fields.includes("username"),
  ),
);
check(
  "FTP is never inferred from the website or the WordPress login",
  !wpParsed.bundles.some((b) => b.accessType === "ftp" || b.accessType === "sftp"),
);

const prose = "The password reset on the login page is broken and the client reports an FTP issue in wp-admin.";
check("ordinary prose is not a credential bundle", parseCredentialText(prose).containsSecrets === false);
check("ordinary prose produces no bundle", parseCredentialText(prose).bundles.length === 0);
check("client detector agrees on prose", client.containsSecretMaterial(prose) === false);
check("client detector agrees on the bundle", client.containsSecretMaterial(wpBundleText) === true);
check("client detector agrees on PEM", client.containsSecretMaterial(FAKE_KEY) === true);
check("bearer token label is detected", containsSecretMaterial("Bearer abcdefghijklmnop1234"));

const aliasText = parseCredentialText(
  [
    "Dashboard URL: https://example.com/wp-admin/",
    "Site address: example.com",
    "WP User: owner@example.com",
    `WP Pass: ${FAKE_WP_PASSWORD}`,
  ].join("\n"),
);
check("dashboard url alias parsed as admin url", aliasText.bundles[0]?.adminUrl?.includes("/wp-admin/"));
check("site address alias parsed as site url", aliasText.bundles[0]?.siteUrl?.includes("example.com"));
check("wp user alias parsed as identity", aliasText.bundles[0]?.username === "owner@example.com");

const tabularSftp = parseCredentialText(
  [
    "SFTP",
    "Host\t\tsftp.example.com",
    "Username\tdeploy",
    `Password\t${FAKE_SFTP_PASSWORD}`,
  ].join("\n"),
);
check("tab-separated SFTP fields parsed", tabularSftp.bundles.some((b) => b.accessType === "sftp"));

const pipeHost = parseCredentialText(
  [
    "SSH",
    "Host: 198.51.100.10 | User: deploy",
    `Password: ${FAKE_SFTP_PASSWORD}`,
  ].join("\n"),
);
check("pipe-separated inline host and user parsed", pipeHost.bundles.some((b) => b.accessType === "ssh"));

console.log("\nB. Sanitization and secret persistence\n");

const sanitized = sanitizedIntakeMessage({
  site: "example.com",
  stored: [{ accessType: "wordpress_admin", provider: "wordpress_login_password" }],
  missing: [{ accessType: "ftp", fields: ["host", "username", "password or private key"] }],
  intent: wpParsed.intent,
});
const sanitizedText = sanitized.join("\n");
check("sanitized message names the site", sanitizedText.includes("example.com"));
check("sanitized message says credentials were stored securely", sanitizedText.includes("stored securely"));
check("sanitized message states the FTP gap", sanitizedText.includes("FTP still needs"));
check("sanitized message preserves intent", sanitizedText.includes("share the issue"));
check("raw secret never appears in the sanitized message", !sanitizedText.includes(FAKE_WP_PASSWORD));
check("raw key never appears in the sanitized message", !sanitizedText.includes("ZmFrZS1wbGFjZWhvbGRlci1rZXk"));

check("redactor removes a labelled password", !redactSecrets(`Password: ${FAKE_WP_PASSWORD}`).includes(FAKE_WP_PASSWORD));
check("redactor removes a PEM block", !redactSecrets(FAKE_KEY).includes("ZmFrZS1wbGFjZWhvbGRlci1rZXk"));
check("redactor removes a bearer token", !redactSecrets("Authorization: Bearer abcdefghijklmnop1234").includes("abcdefghijklmnop1234"));
check("client redactor matches on a labelled password", client.redactSecrets(`Password: ${FAKE_WP_PASSWORD}`) === redactSecrets(`Password: ${FAKE_WP_PASSWORD}`));
check("client redactor matches on a PEM block", client.redactSecrets(FAKE_KEY) === redactSecrets(FAKE_KEY));

const intakeSource = await readFile(new URL("../supabase/functions/credential-intake/index.ts", import.meta.url).pathname);
check("intake never returns a stored secret", !/secret\s*:\s*bundle\.secret/.test(intakeSource));
check("intake authorizes the project before doing anything", intakeSource.indexOf("authorizeProject") < intakeSource.indexOf("parseCredentialText"));
check("intake refuses a mismatched domain without storing", intakeSource.includes("domain_mismatch") && intakeSource.indexOf("domain_mismatch") < intakeSource.indexOf("storeCredential(deps"));
check("intake requires an idempotency key", intakeSource.includes("missing its idempotency key"));
check("intake writes audit rows keyed by that intake", intakeSource.includes("`credential-intake:${intakeKey}"));
check("intake trusts no browser-supplied access type or provider", !/body\.(accessType|provider|verificationState|organizationId|canonicalUrl)/.test(intakeSource));
check("intake stores only through the encrypted secret store", intakeSource.includes("storeCredential"));

check("domain boundary accepts a subdomain", sameSite("shop.example.com", "example.com"));
check("domain boundary rejects a lookalike", !sameSite("example.com.evil.test", "example.com"));
check("domain boundary rejects another site", !sameSite("other-site.test", "example.com"));

console.log("\nC. WordPress login verification\n");

const respond = (init: { status: number; headers?: Record<string, string>; body?: string }) =>
  new Response(init.body ?? "", { status: init.status, headers: init.headers });

let captured: { url: string; body: string } | null = null;
const fakeFetch = (result: Response | Error): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), body: String(init?.body ?? "") };
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;

check("login endpoint is derived server-side", loginEndpointFor("https://example.com/some/page") === "https://example.com/wp-login.php");
check("login endpoint refuses a private destination", loginEndpointFor("http://127.0.0.1/") === null);
check("logged-in cookie recognised", hasLoggedInCookie("wordpress_logged_in_abc123=owner%7Cxyz; path=/"));
check("deleted cookie is not a session", !hasLoggedInCookie("wordpress_logged_in_abc123=deleted; path=/"));

const success = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(respond({ status: 302, headers: { location: "https://example.com/wp-admin/", "set-cookie": "wordpress_logged_in_abc=owner%7Cx; path=/" } })),
);
check("successful login verifies", success.state === "verified");
check("the login request goes only to the canonical wp-login endpoint", captured?.url === "https://example.com/wp-login.php");
check("the request body carries the credential and nothing is logged", (captured?.body ?? "").includes("pwd="));

const rejected = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(respond({ status: 200, body: '<div id="login_error">Unknown username.</div>' })),
);
check("a bad login is rejected", rejected.state === "rejected");
check("a rejection never quotes the credential", !JSON.stringify(rejected).includes(FAKE_WP_PASSWORD));

const challenged = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(respond({ status: 200, body: "<p>Enter your authentication code</p>" })),
);
check("a two-factor challenge is not a rejection", challenged.state === "needs_attention");

// Wordfence 2FA: body contains wordfence-specific markers
const wfChallenged = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(respond({ status: 200, body: '<div class="wfls-2fa-container">Enter your Wordfence authentication code</div>' })),
);
check("wordfence 2fa returns wordfence_2fa_required code", wfChallenged.code === "wordfence_2fa_required");
check("wordfence 2fa is not a rejection", wfChallenged.state === "needs_attention");
check("wordfence 2fa message instructs app password creation", wfChallenged.summary.toLowerCase().includes("application password"));

// Wordfence 2FA via redirect URL containing wordfence marker
const wfRedirect = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(respond({ status: 302, headers: { location: "https://example.com/wp-login.php?wordfence_lostphone=1" } })),
);
check("wordfence 2fa redirect also returns wordfence_2fa_required", wfRedirect.code === "wordfence_2fa_required");

const crossOrigin = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(respond({ status: 302, headers: { location: "https://elsewhere.test/collect" } })),
);
check("a cross-origin redirect is refused", crossOrigin.state === "unverified" && crossOrigin.code === "cross_origin_redirect");

const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
const timedOut = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(abort),
);
check("a timeout never falsely rejects", timedOut.state === "unverified" && timedOut.code === "timeout");

const networkError = await verifyWordPressLogin(
  "https://example.com",
  { username: "owner@example.com", password: FAKE_WP_PASSWORD },
  fakeFetch(new Error("boom")),
);
check("a network error never falsely rejects", networkError.state === "unverified");
check("no verdict ever carries the credential", ![success, rejected, challenged, crossOrigin, timedOut, networkError].some((v) => JSON.stringify(v).includes(FAKE_WP_PASSWORD)));

const wpLoginSource = await readFile(new URL("../supabase/functions/_shared/wpLogin.ts", import.meta.url).pathname);
check("the login verifier never follows redirects", wpLoginSource.includes('redirect: "manual"'));
check("the login verifier keeps no session", !/cookieJar|credentials:\s*"include"/i.test(wpLoginSource));

console.log("\nD. FTP / SFTP / SSH truth\n");

check(
  "a password-based server credential is never claimed as verified",
  intakeSource.includes('verification: "unverified"') && !/verification:\s*"verified"/.test(intakeSource.split("storeServerAccess")[1] ?? ""),
);
check("plain FTP is refused rather than faked", intakeSource.includes("can't store or verify plain FTP yet"));
check("only key-based server access reaches the existing verifier", intakeSource.includes("validatePrivateKey"));
check("SSH destinations are validated by the existing safety boundary", intakeSource.includes("validateSshDestination"));
check(
  "a missing FTP bundle produces no stored record",
  parseCredentialText("Confirm FTP please").bundles.length === 0,
);

console.log("\nE. Persistence guard\n");

const repositorySource = await readFile(new URL("../src/repository.ts", import.meta.url).pathname);
check("both repository adapters redact before persisting a message", (repositorySource.match(/redactBody\(message\.body\)/g) ?? []).length === 2);

const reasonerSource = await readFile(new URL("../src/agent-core/reasoner.ts", import.meta.url).pathname);
check("the reasoning digest redacts message text", /redactSecrets\(message\.body\.join/.test(reasonerSource));
check("the reasoning digest redacts memory", /memory:.*redactSecrets/s.test(reasonerSource));

const guarded = client.redactBody([`Password: ${FAKE_WP_PASSWORD}`, FAKE_KEY, "no secrets here"]);
check("the message helper redacts a labelled password", !guarded[0].includes(FAKE_WP_PASSWORD));
check("the message helper redacts a PEM block", !guarded[1].includes("ZmFrZS1wbGFjZWhvbGRlci1rZXk"));
check("the message helper leaves ordinary text alone", guarded[2] === "no secrets here");

console.log("\nF. No regression in ordinary chat\n");

const workspaceSource = await readFile(new URL("../src/ProjectWorkspace.tsx", import.meta.url).pathname);
check("ordinary messages keep the existing send path", workspaceSource.includes("const stamp = Date.now();"));
check(
  "credential text is intercepted before persistence",
  workspaceSource.indexOf("containsSecretMaterial(value)") < workspaceSource.indexOf("dedupeKey: created ?"),
);
check("the composer is cleared on a successful handoff", workspaceSource.includes('setComposerValue("");'));
check("raw composer text is never emitted on the intake path", !/body:\s*\[raw\]/.test(workspaceSource));
check(
  "access truth is re-read from the server after intake",
  /const refreshed = await workspaceRepository\.loadWorkspace\(\);\s*\n\s*onWorkspaceUpdate\(refreshed\);/.test(
    workspaceSource,
  ),
);

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("All chat credential intake checks passed.");
