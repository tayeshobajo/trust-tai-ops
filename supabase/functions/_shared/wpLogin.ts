/**
 * Read-only WordPress login verification for a normal (non-Application)
 * password.
 *
 * One bounded POST to the project's own canonical `wp-login.php`. Redirects are
 * never followed, so no credential can be forwarded anywhere. No cookie is
 * kept, no session is reused, and the password never reaches a log, an error
 * message or an audit row.
 *
 * Pure TypeScript with an injected fetch, so the same code the server runs is
 * the code the checks exercise.
 */

import { readBounded, validatePublicUrl } from "./net.ts";

export type LoginCredential = { username: string; password: string };

export type LoginVerificationState = "verified" | "rejected" | "unverified" | "needs_attention";

export type LoginVerdict = {
  state: LoginVerificationState;
  code: string | null;
  summary: string;
};

export const LOGIN_PATH = "/wp-login.php";
const LOGIN_TIMEOUT_MS = 12_000;

const CHALLENGE = /(two[- ]factor|2fa|authentication code|one[- ]time (?:code|password)|g-recaptcha|recaptcha|hcaptcha|captcha|verification code)/i;
const LOGIN_ERROR = /id=["']login_error["']|class=["'][^"']*login_error/i;
const ADMIN_SIGNAL = /(wp-admin\/?["'\s>]|id=["']wpadminbar["']|adminmenumain)/i;

const setCookies = (headers: Headers): string => {
  const multi = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (Array.isArray(multi) && multi.length > 0) return multi.join("; ");
  return headers.get("set-cookie") ?? "";
};

/** True only for the cookie WordPress sets once a session really exists. */
export const hasLoggedInCookie = (cookieHeader: string): boolean =>
  /wordpress_logged_in_[a-f0-9]*=(?!deleted|;|\s|$)[^;]+/i.test(cookieHeader);

export const loginEndpointFor = (canonicalUrl: string): string | null => {
  const check = validatePublicUrl(canonicalUrl);
  if (!check.ok) return null;
  return new URL(LOGIN_PATH, check.url.origin).toString();
};

export const verifyWordPressLogin = async (
  canonicalUrl: string | null,
  credential: LoginCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginVerdict> => {
  if (!canonicalUrl) {
    return {
      state: "unverified",
      code: "execution_context_unavailable",
      summary: "I don't have a confirmed site address for this project, so I couldn't check that login.",
    };
  }
  const endpoint = loginEndpointFor(canonicalUrl);
  if (!endpoint) {
    return {
      state: "unverified",
      code: "unsafe_destination",
      summary: "That site address isn't one I'm allowed to reach, so I didn't attempt a login check.",
    };
  }
  const origin = new URL(endpoint).origin;

  const body = new URLSearchParams({
    log: credential.username,
    pwd: credential.password,
    "wp-submit": "Log In",
    redirect_to: `${origin}/wp-admin/`,
    testcookie: "1",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      // Never followed: a redirect must not carry this credential anywhere.
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "TrustTaiOps/1.0 (+read-only access check)",
        cookie: "wordpress_test_cookie=WP+Cookie+check",
      },
      body: body.toString(),
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    // A network problem is never the credential's fault.
    return {
      state: "unverified",
      code: aborted ? "timeout" : "network_error",
      summary: "I couldn't reach the WordPress login to check that access, so nothing changed.",
    };
  }
  clearTimeout(timer);

  const cookies = setCookies(response.headers);
  const location = response.headers.get("location") ?? "";

  if (response.status >= 300 && response.status < 400) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(location, origin).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return {
        state: "unverified",
        code: "cross_origin_redirect",
        summary: "The login sent me to another site, so I stopped rather than follow it with your credentials.",
      };
    }
    if (hasLoggedInCookie(cookies)) {
      return {
        state: "verified",
        code: null,
        summary: "WordPress accepted that login.",
      };
    }
    if (CHALLENGE.test(location)) {
      return {
        state: "needs_attention",
        code: "challenge_required",
        summary: "That login reached a second security step, so I can't confirm it on my own.",
      };
    }
    return {
      state: "unverified",
      code: "inconclusive",
      summary: "WordPress redirected without giving me a signed-in session, so I can't call that login verified.",
    };
  }

  let text = "";
  try {
    text = await readBounded(response);
  } catch {
    text = "";
  }

  if (CHALLENGE.test(text)) {
    return {
      state: "needs_attention",
      code: "challenge_required",
      summary: "That login is protected by a second security step, so I can't confirm it on my own.",
    };
  }
  if (LOGIN_ERROR.test(text)) {
    return {
      state: "rejected",
      code: "invalid_login",
      summary: "WordPress did not accept that username and password.",
    };
  }
  if (hasLoggedInCookie(cookies) && ADMIN_SIGNAL.test(text)) {
    return { state: "verified", code: null, summary: "WordPress accepted that login." };
  }

  return {
    state: "unverified",
    code: "inconclusive",
    summary: "WordPress answered in a way I can't read as a clear yes or no, so I left that access unverified.",
  };
};
