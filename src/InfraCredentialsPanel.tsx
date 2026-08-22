import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "./supabase";

/**
 * Org Infra Credentials (Phase 4) — admin-managed vault for infrastructure
 * secrets that span projects: cPanel API tokens, DigitalOcean, Cloudflare,
 * etc. Values are sealed server-side (AES-GCM) and never return to the
 * browser — the list shows only type, label, config metadata, and
 * verification state.
 */

type InfraCredential = {
  id: string;
  credential_type: string;
  label: string;
  config: Record<string, unknown>;
  verification_state: "unverified" | "verified" | "rejected";
  last_verified_at: string | null;
  created_at: string;
};

const CREDENTIAL_TYPES: Array<[string, string]> = [
  ["cpanel_api", "cPanel API (hosting control)"],
  ["digitalocean", "DigitalOcean (droplets)"],
  ["cloudflare", "Cloudflare (DNS/cache)"],
  ["godaddy_api", "GoDaddy API (domains)"],
  ["resend", "Resend (email)"],
  ["stripe", "Stripe (payments)"],
  ["wpengine", "WP Engine (hosting)"],
  ["sftp_generic", "SFTP (generic)"],
];

const typeLabel = (type: string) =>
  CREDENTIAL_TYPES.find(([value]) => value === type)?.[1] ?? type;

const stateTone = (state: InfraCredential["verification_state"]) =>
  state === "verified" ? "good" : state === "rejected" ? "bad" : "warn";

export function InfraCredentialsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [credentials, setCredentials] = useState<InfraCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    credential_type: "cpanel_api",
    label: "",
    secret: "",
    host: "",
    username: "",
  });

  const load = useCallback(async () => {
    try {
      const supabase = getSupabaseClient();
      const { data, error: fnError } = await supabase.functions.invoke("infra-secrets", {
        body: { action: "list" },
      });
      if (fnError) throw new Error(fnError.message);
      if (data && !data.ok) throw new Error(data.error ?? "list_failed");
      setCredentials((data?.credentials ?? []) as InfraCredential[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (busy) return;
    if (!form.label.trim() || form.secret.trim().length < 8) return;
    setBusy(true);
    try {
      const supabase = getSupabaseClient();
      const config: Record<string, string> = {};
      if (form.host.trim()) config.host = form.host.trim();
      if (form.username.trim()) config.username = form.username.trim();
      const { data, error: fnError } = await supabase.functions.invoke("infra-secrets", {
        body: {
          action: "upsert",
          credential_type: form.credential_type,
          label: form.label.trim(),
          secret: form.secret.trim(),
          config,
        },
      });
      if (fnError) throw new Error(fnError.message);
      if (data && !data.ok) throw new Error(data.error ?? "upsert_failed");
      setForm({ credential_type: form.credential_type, label: "", secret: "", host: "", username: "" });
      setFormOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save credential");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const supabase = getSupabaseClient();
      const { data, error: fnError } = await supabase.functions.invoke("infra-secrets", {
        body: { action: "delete", id },
      });
      if (fnError) throw new Error(fnError.message);
      if (data && !data.ok) throw new Error(data.error ?? "delete_failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete credential");
    } finally {
      setBusy(false);
    }
  };

  const markVerified = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const supabase = getSupabaseClient();
      await supabase.functions.invoke("infra-secrets", {
        body: { action: "verify", id, state: "verified" },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to verify");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-block">
      <h2>Infrastructure credentials</h2>
      <p className="set-note">
        Org-level secrets that span projects — hosting control panels, DNS, deploy infrastructure.
        Sealed with AES-256-GCM server-side; values never return to this browser. Admins only.
      </p>
      {!isAdmin ? (
        <p className="mem-empty">Admin access required to manage infrastructure credentials.</p>
      ) : loading ? (
        <p className="mem-empty">Loading…</p>
      ) : (
        <>
          {error ? <p className="mem-empty tone-bad">{error}</p> : null}
          {credentials.length === 0 ? (
            <p className="mem-empty">
              No infrastructure credentials stored yet. Add the ones Captain jobs need — e.g. a cPanel
              API token for SSL installs.
            </p>
          ) : (
            <ul className="pw-task-surface">
              {credentials.map((cred) => (
                <li key={cred.id}>
                  <div className="pw-outcome-row">
                    <span className="pw-outcome-main">
                      <strong>{cred.label}</strong>
                      <small>
                        {typeLabel(cred.credential_type)}
                        {typeof cred.config?.host === "string" ? ` · ${cred.config.host}` : ""}
                        {typeof cred.config?.username === "string" ? ` · ${cred.config.username}` : ""}
                      </small>
                    </span>
                    <span className={`pw-outcome-verdict tone-${stateTone(cred.verification_state)}`}>
                      {cred.verification_state}
                    </span>
                    {cred.verification_state === "unverified" ? (
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={busy}
                        onClick={() => markVerified(cred.id)}
                      >
                        Mark verified
                      </button>
                    ) : null}
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={busy}
                      onClick={() => remove(cred.id)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {formOpen ? (
            <div className="set-rows">
              <div className="set-row">
                <dt>Type</dt>
                <dd>
                  <select
                    value={form.credential_type}
                    onChange={(e) => setForm({ ...form, credential_type: e.target.value })}
                  >
                    {CREDENTIAL_TYPES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </dd>
              </div>
              <div className="set-row">
                <dt>Label</dt>
                <dd>
                  <input
                    placeholder="e.g. GoDaddy cPanel — deerparkranch"
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                </dd>
              </div>
              <div className="set-row">
                <dt>Secret</dt>
                <dd>
                  <input
                    type="password"
                    placeholder="API token / password"
                    value={form.secret}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  />
                </dd>
              </div>
              <div className="set-row">
                <dt>Host (optional)</dt>
                <dd>
                  <input
                    placeholder="e.g. p3plzcpnl505705.prod.phx3.secureserver.net"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                  />
                </dd>
              </div>
              <div className="set-row">
                <dt>Username (optional)</dt>
                <dd>
                  <input
                    placeholder="e.g. deerparkranch"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </dd>
              </div>
              <div className="decision-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy || !form.label.trim() || form.secret.trim().length < 8}
                  onClick={submit}
                >
                  {busy ? "Saving…" : "Save credential"}
                </button>
                <button className="ghost-button" type="button" onClick={() => setFormOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="decision-actions">
              <button className="primary-button" type="button" onClick={() => setFormOpen(true)}>
                Add credential
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
