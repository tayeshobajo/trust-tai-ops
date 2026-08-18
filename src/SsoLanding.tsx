import { useEffect, useState } from "react";
import { exchangeOsHandoff } from "./suite/client";
import { readHandoffMessage, parseOriginAllowlist, SSO_READY_TYPE, locationCarriesToken } from "./suite/ssoBridge";
import { osOriginSourceForBuild, resolveOpsEnv } from "./env";

type LandingState =
  | { phase: "waiting" }
  | { phase: "exchanging" }
  | { phase: "ready"; email: string }
  | { phase: "timed_out" }
  | { phase: "failed"; detail: string };

const FAILURE_COPY: Record<string, string> = {
  origin_rejected: "That handoff did not come from a recognised Trust Tai OS address.",
  missing_organization_id: "That handoff did not say which Trust Tai OS organization it came from.",
  malformed_organization_id: "That handoff carried an unusable Trust Tai OS organization.",
  os_token_rejected: "Your Trust Tai OS session has expired. Sign in there again, then relaunch Ops.",
  no_ops_membership: "This account does not have Ops access yet. Ask an Ops admin to add you.",
  ops_access_disabled: "Ops access for this account is disabled.",
  os_not_configured: "The suite connection is not configured for this deployment.",
  session_bootstrap_failed: "Ops recognised the account but could not start a session. Try again in a moment.",
  local_session_failed: "Ops recognised the account but could not start a session. Try again in a moment.",
  ops_account_unavailable: "Ops could not open an account for this person. Ask an Ops admin to check the membership.",
};

/** Names the refused account when the server told us which one it was. */
function failureCopy(code: string, email: string | null | undefined): string {
  const base = FAILURE_COPY[code] ?? "That handoff could not be accepted.";
  if (!email) return base;
  if (code === "no_ops_membership") {
    return `${email} does not have Ops access yet. Ask an Ops admin to add this address.`;
  }
  if (code === "ops_access_disabled") return `Ops access for ${email} is disabled.`;
  return base;
}

/** How long to keep announcing readiness before saying plainly that nothing arrived. */
const READY_PING_INTERVAL_MS = 400;
const HANDOFF_TIMEOUT_MS = 12000;

/**
 * The /sso landing state. It waits for a postMessage from an exactly-matched
 * Trust Tai OS origin, hands the token straight to the server for
 * verification, and never puts it in the address bar or in storage.
 */
export function SsoLanding({ onSignedIn }: { onSignedIn: (targetPath: string | null) => void }) {
  const [state, setState] = useState<LandingState>({ phase: "waiting" });

  useEffect(() => {
    const env = resolveOpsEnv();
    // Production bundles trust only the production Core origin; preview
    // origins are separated by environment, never merged into production.
    const allowlist = parseOriginAllowlist(osOriginSourceForBuild(env));
    let done = false;

    if (locationCarriesToken(window.location.href)) {
      // Fail closed rather than accept a token that has already leaked into
      // history, referrers, and server logs.
      window.history.replaceState(null, "", "/sso");
      setState({ phase: "failed", detail: "A session cannot be handed over through the address bar." });
      return;
    }

    const handler = async (event: MessageEvent) => {
      if (done) return;

      // Only the window that opened us (or embeds us) may hand over a session.
      // `window.parent === window` for a normal tab, which is not a real
      // relationship, so it is not treated as an expected source.
      const parent = window.parent !== window ? window.parent : null;
      const expectedSource = window.opener ?? parent;
      if (expectedSource && event.source !== expectedSource) return;
      if (!expectedSource) return;

      const read = readHandoffMessage({ origin: event.origin, data: event.data }, allowlist);
      if (!read.ok) {
        if (read.reason !== "not_a_handoff") {
          setState({ phase: "failed", detail: FAILURE_COPY[read.reason] ?? "That handoff could not be accepted." });
        }
        return;
      }

      done = true;
      setState({ phase: "exchanging" });

      const targetPath = read.handoff.targetPath;
      const result = await exchangeOsHandoff(read.handoff);

      if (result.ok) {
        setState({ phase: "ready", email: result.email });
        onSignedIn(targetPath);
      } else {
        setState({ phase: "failed", detail: failureCopy(result.error, result.email) });
      }
    };

    window.addEventListener("message", handler);

    // Tell the opener we are listening. Posted to each allowed origin
    // individually so no wildcard target is ever used, and repeated for a
    // short while: Core may attach its listener after Ops finishes loading,
    // and a single ping lost to that race is what leaves a signed-in Core
    // user staring at the Ops sign-in screen.
    const opener = window.opener ?? (window.parent !== window ? window.parent : null);
    const announce = () => {
      for (const origin of allowlist) {
        try {
          opener?.postMessage({ type: SSO_READY_TYPE }, origin);
        } catch {
          // A closed or cross-origin-restricted opener is not an error.
        }
      }
    };

    announce();
    const pinger = window.setInterval(() => {
      if (done) {
        window.clearInterval(pinger);
        return;
      }
      announce();
    }, READY_PING_INTERVAL_MS);

    // Never hang silently. If nothing arrives, say so explicitly rather than
    // dropping the visitor into an unexplained sign-in screen.
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      setState({ phase: "timed_out" });
    }, HANDOFF_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", handler);
      window.clearInterval(pinger);
      window.clearTimeout(timer);
    };
  }, [onSignedIn]);

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/trust-tai-logo.png" alt="Trust Tai" />
          <p className="eyebrow">Ops</p>
          <h1>Opening your workspace</h1>
          <p>
            {state.phase === "waiting" && "Waiting for Trust Tai OS to hand over your session."}
            {state.phase === "exchanging" && "Confirming who you are with Trust Tai OS."}
            {state.phase === "ready" && `Signed in as ${state.email}. Taking you to your projects.`}
            {state.phase === "timed_out" &&
              "Trust Tai OS did not hand over a session. Open Ops again from Trust Tai OS, or sign in to Ops directly."}
            {state.phase === "failed" && state.detail}
          </p>
        </div>

        {(state.phase === "failed" || state.phase === "timed_out") && (
          <button type="button" className="primary-button" onClick={() => { window.location.href = "/"; }}>
            Sign in to Ops directly
          </button>
        )}
      </div>
    </div>
  );
}