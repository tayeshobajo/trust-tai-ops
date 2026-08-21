/**
 * Google service account authentication for the Search Console API.
 *
 * Service accounts authenticate via a self-signed JWT (RS256) that is
 * exchanged for a short-lived OAuth2 access token. The private key never
 * leaves this module; the only thing that crosses the network is the signed
 * assertion and, in return, an access token string.
 *
 * No npm packages. No Deno std. Pure Web Crypto API (available in Deno Deploy).
 */

export type GscAuthResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; code: string; summary: string };

export type ServiceAccountKey = {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
};

// ---------------------------------------------------------------------------
// JWT helpers (RS256 using Web Crypto)
// ---------------------------------------------------------------------------

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlEncode = (str: string): string =>
  b64url(new TextEncoder().encode(str).buffer as ArrayBuffer);

/**
 * Import an RSA private key from a PEM-encoded PKCS#8 string.
 * Google service account keys arrive in PKCS#8 format.
 */
const importPrivateKey = async (pem: string): Promise<CryptoKey> => {
  // Strip PEM headers and collapse whitespace (service account keys include
  // literal \n escape sequences as well as real newlines).
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");

  const binary = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
};

/** Build and sign a JWT assertion for the Google OAuth2 token endpoint. */
const buildJwt = async (key: ServiceAccountKey, scope: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: key.private_key_id };
  const payload = {
    iss: key.client_email,
    sub: key.client_email,
    scope,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const cryptoKey = await importPrivateKey(key.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64url(signature)}`;
};

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/**
 * Parse the sealed service account JSON from the secret store, sign a JWT,
 * and exchange it for a short-lived Google OAuth2 access token.
 *
 * `plaintext` is the raw JSON string sealed by storeCredential. It must match
 * the service account JSON shape Google produces.
 */
export const getGscAccessToken = async (plaintext: string): Promise<GscAuthResult> => {
  let key: ServiceAccountKey;
  try {
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    if (
      parsed.type !== "service_account" ||
      typeof parsed.client_email !== "string" ||
      typeof parsed.private_key !== "string" ||
      typeof parsed.token_uri !== "string"
    ) {
      return {
        ok: false,
        code: "invalid_credential",
        summary:
          "The stored service account JSON is missing required fields (type, client_email, private_key, token_uri). Re-upload the key from Google Cloud Console.",
      };
    }
    key = parsed as unknown as ServiceAccountKey;
  } catch {
    return {
      ok: false,
      code: "invalid_credential",
      summary: "The stored service account credential could not be parsed. Re-upload the key from Google Cloud Console.",
    };
  }

  let jwt: string;
  try {
    jwt = await buildJwt(key, GSC_SCOPE);
  } catch (err) {
    return {
      ok: false,
      code: "jwt_sign_failed",
      summary: `Could not sign the service account JWT: ${err instanceof Error ? err.message : "unknown error"}. The private key may be malformed.`,
    };
  }

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    res = await fetch(key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    return {
      ok: false,
      code: "token_fetch_failed",
      summary: "Could not reach the Google OAuth2 token endpoint. Check network access from the edge function.",
    };
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json() as Record<string, unknown>;
      detail = String(body.error_description ?? body.error ?? "");
    } catch { /* ignore */ }
    return {
      ok: false,
      code: "token_exchange_failed",
      summary: detail
        ? `Google rejected the service account credential: ${detail}. Make sure the service account is added as a user in Search Console.`
        : `Google returned HTTP ${res.status} when exchanging the service account JWT.`,
    };
  }

  let body: Record<string, unknown>;
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    return { ok: false, code: "token_parse_failed", summary: "Google returned an unreadable token response." };
  }

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;

  if (!accessToken) {
    return { ok: false, code: "token_missing", summary: "Google returned a token response but no access_token was present." };
  }

  return { ok: true, accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn };
};
