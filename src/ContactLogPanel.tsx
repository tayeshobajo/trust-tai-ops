import { useMemo, useState } from "react";
import type { ContactEvent, Organization, Project } from "./types";
import { workspaceRepository } from "./repository";
import { getProjectInitials } from "./home";

/**
 * Client Contact Log — Phase 5 cadence source.
 *
 * The monitor's client-cadence check reads from project_contact_events.
 * This panel is where humans log real contacts (call, email, meeting) so the
 * monitor has a durable, honest baseline instead of guessing.
 */

const CHANNELS: Array<{ id: ContactEvent["channel"]; label: string }> = [
  { id: "email", label: "Email" },
  { id: "phone", label: "Phone" },
  { id: "meeting", label: "Meeting" },
  { id: "sms", label: "SMS" },
  { id: "slack", label: "Slack" },
  { id: "other", label: "Other" },
];

const CADENCE_WARN_DAYS = 30;

type Props = {
  project: Project;
  canWrite: boolean;
  embedded?: boolean;
  onWorkspaceUpdate: (next: Organization) => void;
};

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
};

export function ContactLogPanel({ project, canWrite, embedded = false, onWorkspaceUpdate }: Props) {
  const [channel, setChannel] = useState<ContactEvent["channel"]>("email");
  const [direction, setDirection] = useState<ContactEvent["direction"]>("outbound");
  const [when, setWhen] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const events = useMemo(
    () => [...project.contactEvents].sort((a, b) => b.contactedAt.localeCompare(a.contactedAt)),
    [project.contactEvents],
  );

  const daysSince = useMemo(() => {
    if (events.length === 0) return null;
    const last = new Date(events[0].contactedAt);
    return Math.floor((Date.now() - last.getTime()) / 86_400_000);
  }, [events]);

  const logContact = async () => {
    if (!canWrite || busy || !summary.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await workspaceRepository.addContactEvent(project.id, {
        contactedAt: new Date(`${when}T12:00:00`).toISOString(),
        channel,
        direction,
        summary: summary.trim(),
      });
      onWorkspaceUpdate(await workspaceRepository.loadWorkspace());
      setNotice("Contact logged. Cadence monitoring now uses this as the baseline.");
      setSummary("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-surface">
      <header className="access-head">
        {!embedded ? null : null}
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div>
          <p className="eyebrow">Client contact history</p>
          <h1>{project.name}</h1>
          <small>{project.primaryDomain}</small>
        </div>
      </header>

      {notice ? <p className="access-notice">{notice}</p> : null}
      {error ? <p className="access-notice is-error">{error}</p> : null}

      <p className="access-intro">
        Every logged touchpoint feeds the cadence monitor. No contact in {CADENCE_WARN_DAYS}+ days and Captain gets asked to plan a re-engagement.
      </p>

      {daysSince === null ? (
        <p className="mem-empty">No contact logged yet. Log the first one so monitoring has a real baseline.</p>
      ) : (
        <p className="mem-overview">
          Last contact: <strong>{fmtDate(events[0].contactedAt)}</strong> ({daysSince} day{daysSince === 1 ? "" : "s"} ago)
          {daysSince >= CADENCE_WARN_DAYS ? " — cadence overdue." : "."}
        </p>
      )}

      {canWrite ? (
        <div className="mem-actions contact-form">
          <div className="contact-form-row">
            <label>
              <span>Channel</span>
              <select value={channel} onChange={(event) => setChannel(event.target.value as ContactEvent["channel"])}>
                {CHANNELS.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Direction</span>
              <select value={direction} onChange={(event) => setDirection(event.target.value as ContactEvent["direction"])}>
                <option value="outbound">We reached out</option>
                <option value="inbound">They reached out</option>
              </select>
            </label>
            <label>
              <span>Date</span>
              <input type="date" value={when} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setWhen(event.target.value)} />
            </label>
          </div>
          <label className="contact-summary">
            <span>What happened</span>
            <input
              type="text"
              value={summary}
              placeholder="e.g. Monthly check-in call — plugin updates approved"
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <button className="ghost-button" type="button" disabled={busy || !summary.trim()} onClick={logContact}>
            {busy ? "Logging…" : "Log contact"}
          </button>
        </div>
      ) : null}

      {events.length > 0 ? (
        <section className="mem-section">
          <h2>History</h2>
          <ul className="mem-list">
            {events.map((event) => (
              <li key={event.id} className="mem-entry">
                <div className="mem-entry-head">
                  <strong>{CHANNELS.find((item) => item.id === event.channel)?.label ?? event.channel}</strong>
                  <span className={`mem-weight is-${event.direction === "outbound" ? "medium" : "high"}`}>
                    {event.direction === "outbound" ? "Outbound" : "Inbound"}
                  </span>
                </div>
                <p>{event.summary}</p>
                <small>{fmtDate(event.contactedAt)}{event.recordedByEmail ? ` · logged by ${event.recordedByEmail}` : ""}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
