/**
 * A real signed-in WordPress session, opened read-only.
 *
 * Plenty of hosts strip the Authorization header, and plenty of people share
 * their normal login password rather than an Application Password. In both
 * cases REST Basic auth answers 401 even though the access is genuinely good —
 * which is exactly the state the access panel already proves via the login
 * form. This module turns that same bounded login POST into a session cookie
 * so private *reads* can actually happen instead of being reported as a
 * rejected credential.
 *
 * Nothing here mutates WordPress: the cookie is only ever used for GETs, it is
 * never persisted, and it never leaves the project's own origin.
 */

import { validatePublicUrl } from "./net.ts";
import { hasLoggedInCookie, loginEndpointFor } from "./wpLogin.ts";

export type SessionResult =
  | { ok: true; cookie: string; nonce: string | null }
  | { ok: false; code: "unsafe_destination" | "network_error" | "rejected" | "inconclusive" };

const TIMEOUT_MS = 12_000;

const collectCookies = (headers: Headers): string => {
  const multi = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  const raw = Array.isArray(multi) && multi.length > 0 ? multi : [headers.get("set-cookie") ?? ""];
  return raw
    .filter((value) => value.trim().length > 0)
    .map((value) => value.split(";")[0].trim())
    // WordPress appends a hash containing digits to its authenticated cookie
    // names. Dropping those digits silently discarded a valid login session.
    .filter((pair) => /^wordpress[_a-z0-9-]*=/i.test(pair))
    .join("; ");
};

const restNonceFromHtml = (html: string): string | null => {
  const patterns = [
    /wpApiSettings\s*=\s*\{[\s\S]{0,2000}?["']nonce["']\s*:\s*["']([^"']+)["']/i,
    /["']nonce["']\s*:\s*["']([^"']+)["'][\s\S]{0,500}?["']root["']/i,
    /name=["']_wpnonce["']\s+value=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const nonce = html.match(pattern)?.[1]?.trim();
    if (nonce && /^[a-zA-Z0-9_-]{6,64}$/.test(nonce)) return nonce;
  }
  return null;
};

export const openWordPressSession = async (
  canonicalUrl: string | null,
  credential: { username: string; password: string },
  fetchImpl: typeof fetch = fetch,
  loginPath?: string,
): Promise<SessionResult> => {
  if (!canonicalUrl) return { ok: false, code: "unsafe_destination" };
  const base = validatePublicUrl(canonicalUrl);
  if (!base.ok) return { ok: false, code: "unsafe_destination" };
  const endpoint = loginEndpointFor(canonicalUrl, loginPath);
  if (!endpoint) return { ok: false, code: "unsafe_destination" };
  const origin = new URL(endpoint).origin;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      // Never followed: a redirect must not carry this credential anywhere.
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TrustTaiOps/1.0 (+read-only session)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: endpoint,
        origin,
        cookie: "wordpress_test_cookie=WP+Cookie+check",
      },
      body: new URLSearchParams({
        log: credential.username,
        pwd: credential.password,
        "wp-submit": "Log In",
        redirect_to: `${origin}/wp-admin/`,
        testcookie: "1",
      }).toString(),
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, code: "network_error" };
  }
  clearTimeout(timer);

  const cookies = collectCookies(response.headers);
  await response.body?.cancel().catch(() => undefined);

  if (hasLoggedInCookie(cookies)) {
    // WordPress cookie authentication for REST requests also requires a
    // wp_rest nonce. Read it from the signed-in admin page; both the cookie and
    // nonce remain in memory and are only used for same-origin GET requests.
    let nonce: string | null = null;
    try {
      const adminUrl = new URL("/wp-admin/", origin).toString();
      const admin = await fetchImpl(adminUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TrustTaiOps/1.0 (+read-only session)",
          accept: "text/html,application/xhtml+xml",
          referer: endpoint,
          cookie: cookies,
        },
      });
      if (admin.ok && new URL(admin.url || adminUrl).origin === origin) {
        nonce = restNonceFromHtml((await admin.text()).slice(0, 1_000_000));
      } else {
        await admin.body?.cancel().catch(() => undefined);
      }
    } catch {
      nonce = null;
    }
    return { ok: true, cookie: cookies, nonce };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, code: "inconclusive" };
  return { ok: false, code: "rejected" };
};
