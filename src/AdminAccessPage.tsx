import { useEffect, useState } from "react";
import {
  grantOpsAccess,
  listOpsMembers,
  membershipFailureCopy,
  readOpsAccessSettings,
  revokeOpsAccess,
  updateOpsAccessSettings,
} from "./opsMembership";
import type { OpsAccessSettings, OpsMember, OpsRole } from "./opsMembership";
import type { AuthState } from "./types";

type Feedback = { tone: "good" | "bad"; text: string } | null;

const ROLE_LABEL: Record<OpsRole, string> = {
  viewer: "Can look, cannot act",
  operator: "Can run work",
  senior_operator: "Can run work and approve",
  admin: "Full access, including who else gets in",
};

const ROLE_ORDER: OpsRole[] = ["viewer", "operator", "senior_operator", "admin"];

const PAGE_SIZE = 20;

/**
 * Who can open Ops, and what happens when they try.
 *
 * This is the page an admin lands on after someone is turned away at the
 * Trust Tai OS handoff: adding the exact address named on that screen is all
 * that is needed for the next sign-in to complete.
 */
export function AdminAccessPage({ authState }: { authState: AuthState }) {
  const [members, setMembers] = useState<OpsMember[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<OpsAccessSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<OpsRole>("operator");
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = async (nextPage = page, nextQuery = query) => {
    const result = await listOpsMembers({ search: nextQuery, page: nextPage, pageSize: PAGE_SIZE });
    setLoading(false);
    if (!result.ok) {
      setBlocked(membershipFailureCopy(result.error));
      return;
    }
    setBlocked(null);
    setMembers(result.members);
    setTotal(result.total ?? result.members.length);
  };

  useEffect(() => {
    void refresh(page, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, query]);

  useEffect(() => {
    void readOpsAccessSettings().then((result) => {
      if (result.ok) setSettings(result.settings);
    });
  }, []);

  // Typing filters the list without a button; the server does the matching.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const saveSettings = async (patch: { autoProvision?: boolean; autoProvisionRole?: OpsRole }) => {
    setSavingSettings(true);
    const result = await updateOpsAccessSettings(patch);
    setSavingSettings(false);
    if (!result.ok) {
      setFeedback({ tone: "bad", text: membershipFailureCopy(result.error) });
      return;
    }
    setSettings(result.settings);
  };

  const handleGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address) return;

    setBusyEmail(address);
    setFeedback(null);
    const result = await grantOpsAccess({ email: address, fullName: fullName.trim() || undefined, role });
    setBusyEmail(null);

    if (!result.ok) {
      setFeedback({ tone: "bad", text: membershipFailureCopy(result.error, address) });
      return;
    }

    setEmail("");
    setFullName("");
    setFeedback({
      tone: "good",
      text: `${result.member.email} can now open Ops from Trust Tai OS. Ask them to relaunch Ops.`,
    });
    await refresh(page, query);
  };

  const handleRevoke = async (member: OpsMember) => {
    setBusyEmail(member.email);
    setFeedback(null);
    const result = await revokeOpsAccess(member.email);
    setBusyEmail(null);

    if (!result.ok) {
      setFeedback({ tone: "bad", text: membershipFailureCopy(result.error, member.email) });
      return;
    }

    setFeedback({
      tone: "good",
      text: `${member.email} can no longer open Ops. Their history is kept.`,
    });
    await refresh(page, query);
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="global-surface">
      <header className="global-surface-head">
        <p className="eyebrow">Workspace</p>
        <h1>Ops access</h1>
        <p className="global-surface-lede">
          Everyone who can open Ops, including people arriving from Trust Tai OS. Access is checked by the server on
          every sign-in — this list is the only thing that decides it.
        </p>
      </header>

      {blocked ? (
        <section className="set-block">
          <h2>Not available</h2>
          <p className="set-note">{blocked}</p>
          <p className="set-note">Signed in as {authState.userEmail ?? "an unknown account"}.</p>
        </section>
      ) : (
        <>
          <section className="set-block">
            <h2>Automatic access from Trust Tai OS</h2>
            <p className="set-note">
              {settings?.trust_tai_os_organization_id
                ? "This workspace is linked to your Trust Tai OS organization. People accepted there can be let into Ops the first time they open it, with no manual step."
                : "Not linked yet. The next time someone who already has Ops access opens Ops from Trust Tai OS, the link is recorded automatically."}
            </p>
            <label className="field">
              <span>New people from Trust Tai OS</span>
              <select
                value={settings?.ops_auto_provision === false ? "off" : "on"}
                disabled={!settings || savingSettings}
                onChange={(event) => void saveSettings({ autoProvision: event.target.value === "on" })}
              >
                <option value="on">Let them in automatically</option>
                <option value="off">Require me to add them by hand</option>
              </select>
            </label>
            <label className="field">
              <span>What they can do on arrival</span>
              <select
                value={settings?.ops_auto_provision_role ?? "viewer"}
                disabled={!settings || savingSettings || settings.ops_auto_provision === false}
                onChange={(event) => void saveSettings({ autoProvisionRole: event.target.value as OpsRole })}
              >
                {ROLE_ORDER.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ")} — {ROLE_LABEL[option]}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="set-block">
            <h2>Give someone access</h2>
            <form className="admin-access-form" onSubmit={handleGrant}>
              <label className="field">
                <span>Email address</span>
                <input
                  type="email"
                  required
                  value={email}
                  placeholder="name@company.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Name (optional)</span>
                <input
                  type="text"
                  value={fullName}
                  placeholder="How they should appear"
                  onChange={(event) => setFullName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>What they can do</span>
                <select value={role} onChange={(event) => setRole(event.target.value as OpsRole)}>
                  {ROLE_ORDER.map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, " ")} — {ROLE_LABEL[option]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="primary-button" disabled={busyEmail !== null}>
                {busyEmail && busyEmail === email.trim().toLowerCase() ? "Granting..." : "Grant access"}
              </button>
            </form>

            {feedback ? (
              <p className={`admin-access-feedback tone-${feedback.tone}`} role="status">
                {feedback.text}
              </p>
            ) : null}

            <p className="set-note">
              Granting an existing address updates what that person can do and restores access if it was removed.
            </p>
          </section>

          <section className="set-block">
            <h2>People with access</h2>
            <label className="field">
              <span>Find someone</span>
              <input
                type="search"
                value={search}
                placeholder="Search by email or name"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {loading ? (
              <p className="set-note">Reading the membership list...</p>
            ) : members.length === 0 ? (
              <p className="set-note">{query ? `No one matches "${query}".` : "No one has Ops access yet."}</p>
            ) : (
              <>
              <ul className="set-list admin-access-list">
                {members.map((member) => {
                  const active = member.status === "active";
                  const isSelf = member.email === (authState.userEmail ?? "").toLowerCase();
                  return (
                    <li key={member.id}>
                      <span>
                        <strong>{member.full_name || member.email}</strong>
                        <small>
                          {member.email} · {member.role.replace(/_/g, " ")}
                          {member.provisioned_via === "trust_tai_os" ? " · added from Trust Tai OS" : ""}
                        </small>
                      </span>
                      <span className="admin-access-actions">
                        <span className={`status-chip ${active ? "tone-good" : "tone-quiet"}`}>
                          {active ? "Can sign in" : "Access removed"}
                        </span>
                        {active && !isSelf ? (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busyEmail === member.email}
                            onClick={() => handleRevoke(member)}
                          >
                            {busyEmail === member.email ? "Removing..." : "Remove access"}
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="admin-access-pager">
                <span className="set-note">
                  Showing {rangeStart}–{rangeEnd} of {total}
                </span>
                <span className="admin-access-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={page >= pageCount}
                    onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  >
                    Next
                  </button>
                </span>
              </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
