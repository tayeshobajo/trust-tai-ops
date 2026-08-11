import { useState } from "react";
import { loadAuthState } from "./auth";
import { getSupabaseClient } from "./supabase";
import type { AuthState } from "./types";

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const client = getSupabaseClient();

      if (mode === "signup") {
        const { error: signUpError } = await client.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
              role: "admin",
            },
          },
        });

        if (signUpError) throw signUpError;
      } else {
        const { error: signInError } = await client.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError) throw signInError;
      }

      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/trust-tai-logo.png" alt="Trust Tai" />
          <p className="eyebrow">Ops</p>
          <h1>Engineering Command Center</h1>
          <p>Sign in to the engineering command center.</p>
        </div>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === "signin" ? "is-active" : ""}`}
            onClick={() => setMode("signin")}
          >
            Sign In
          </button>
          <button
            className={`auth-tab ${mode === "signup" ? "is-active" : ""}`}
            onClick={() => setMode("signup")}
          >
            Create Account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === "signup" && (
            <label className="field">
              <span>Full name</span>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Tai Shobajo"
                required
              />
            </label>
          )}

          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tai@trusttai.com"
              required
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? "Working..." : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <p className="auth-foot">
          Access is organization-scoped. New accounts map to the TrustTai org on first login.
        </p>
      </div>
    </div>
  );
}

export function useAuthReload() {
  const [authState, setAuthState] = useState<AuthState>({
    adapter: "supabase",
    isAuthenticated: false,
    userEmail: null,
    userId: null,
    role: null,
    status: "loading",
    message: "Loading auth state...",
  });

  const reload = async () => {
    const next = await loadAuthState();
    setAuthState(next);
  };

  return { authState, reload, setAuthState };
}
