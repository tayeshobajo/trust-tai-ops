import { useEffect, useState } from "react";
import {
  grantOpsAccess,
  listOpsMembers,
  membershipFailureCopy,
  revokeOpsAccess,
} from "./opsMembership";
import type { OpsMember, OpsRole } from "./opsMembership";
import type { AuthState } from "./types";

type Feedback = { tone: "good" | "bad"; text: string } | null;

const ROLE_LABEL: Record<OpsRole, string> = {
  viewer: "Can look, cannot act",
  operator: "Can run work",
  senior_operator: "Can run work and approve",
  admin: "Full access, including who else gets in",
};

const ROLE_ORDER: OpsRole[] = ["viewer", "operator", "senior_operator", "admin"];

/**
 * Who can open Ops, and what happens when they try.
 *
 * This is the page an admin lands on after someone is turned away at the
 * Trust Tai OS handoff: adding the exact address named on that screen is all
 * that is needed for the next sign-in to complete.
 */
export function AdminAccessPage({ authState }: { authState: AuthState }) {
  const [members, setMembers] = useState<OpsMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<OpsRole>("operator");
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = async () => {
    const result = await listOpsMembers();
    setLoading(false);
    if (!result.ok) {
      setBlocked(membershipFailureCopy(result.error));
      return;
    }
    setBlocked(null);
    setMembers(result.members);
  };

  useEffect(() => {
    void refresh();
  }, []);

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
    await refresh();
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
    await refresh();
  };

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
            {loading ? (
              <p className="set-note">Reading the membership list...</p>
            ) : members.length === 0 ? (
              <p className="set-note">No one has Ops access yet.</p>
            ) : (
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
            )}
          </section>
        </>
      )}
    </div>
  );
}
