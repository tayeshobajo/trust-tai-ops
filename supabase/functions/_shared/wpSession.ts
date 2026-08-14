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
  | { ok: true; cookie: string }
  | { ok: false; code: "unsafe_destination" | "network_error" | "rejected" | "inconclusive" };

const TIMEOUT_MS = 12_000;

const collectCookies = (headers: Headers): string => {
  const multi = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  const raw = Array.isArray(multi) && multi.length > 0 ? multi : [headers.get("set-cookie") ?? ""];
  return raw
    .filter((value) => value.trim().length > 0)
    .map((value) => value.split(";")[0].trim())
    .filter((pair) => /^wordpress[_a-z]*=/i.test(pair))
    .join("; ");
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
        "user-agent": "TrustTaiOps/1.0 (+read-only session)",
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

  if (hasLoggedInCookie(cookies)) return { ok: true, cookie: cookies };
  if (response.status >= 300 && response.status < 400) return { ok: false, code: "inconclusive" };
  return { ok: false, code: "rejected" };
};
