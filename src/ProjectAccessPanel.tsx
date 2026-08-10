import { useMemo, useState } from "react";
import type { AccessType, Organization, Project, ProjectAccessMethod } from "./types";
import { workspaceRepository } from "./repository";
import { getProjectInitials } from "./home";
import { submitCredential } from "./agent-core/secrets";

type Props = {
  project: Project;
  canWrite: boolean;
  focusTypes?: AccessType[];
  onBackToConversation: () => void;
  onWorkspaceUpdate: (next: Organization) => void;
  // Conversation history only. The panel never passes submitted values here —
  // the event is built from the predefined connection label and the action.
  onAccessEvent?: (event: AccessEvent) => void;
};

export type AccessEventAction = "added" | "replaced" | "reverified" | "removed";
export type AccessEvent = { type: AccessType; label: string; action: AccessEventAction };

type FieldKind = "text" | "secret";
type Field = { key: string; label: string; kind: FieldKind; placeholder?: string; hint?: string };

const CONNECTION_TYPES: Array<{
  type: AccessType;
  label: string;
  blurb: string;
  authMethod: string;
  fields: Field[];
  /** True when a real credential can be sealed server-side for this type. */
  executable?: boolean;
}> = [
  {
    type: "wordpress_admin",
    label: "WordPress Admin",
    blurb: "The usual first door for diagnosis and plugin-level checks.",
    authMethod: "Application Password",
    executable: true,
    fields: [
      { key: "user", label: "WordPress username", kind: "text" },
      {
        key: "secret",
        label: "Application Password",
        kind: "secret",
        placeholder: "xxxx xxxx xxxx xxxx xxxx xxxx",
        hint: "In WordPress: Users → Profile → Application Passwords. It can be revoked on its own, and your login password is never needed.",
      },
    ],
  },
  {
    type: "sftp",
    label: "SFTP / FTP",
    blurb: "File-level access for themes, plugins, and uploads.",
    authMethod: "SFTP credentials",
    fields: [
      { key: "host", label: "Host", kind: "text", placeholder: "sftp.example.com" },
      { key: "user", label: "Username", kind: "text" },
    ],
  },
  {
    type: "ssh",
    label: "SSH",
    blurb: "Server-level access for logs, CLI work, and deeper cleanup.",
    authMethod: "SSH key or password",
    fields: [
      { key: "host", label: "Host", kind: "text", placeholder: "example.com" },
      { key: "user", label: "Username", kind: "text" },
    ],
  },
  {
    type: "hosting_portal",
    label: "Hosting account / Other",
    blurb: "Useful for backups, restores, and host-level verification.",
    authMethod: "Hosting portal login",
    fields: [
      { key: "host", label: "Hosting provider", kind: "text", placeholder: "Kinsta, SiteGround, WP Engine..." },
      { key: "user", label: "Account email", kind: "text" },
    ],
  },
  {
    type: "database",
    label: "Database access",
    blurb: "Only needed when a task touches data directly.",
    authMethod: "Database credentials",
    fields: [
      { key: "host", label: "Host", kind: "text" },
      { key: "user", label: "Database user", kind: "text" },
    ],
  },
  {
    type: "cdn",
    label: "CDN / Cloudflare",
    blurb: "For cache, DNS, and edge-layer checks.",
    authMethod: "CDN account access",
    fields: [
      { key: "host", label: "Provider", kind: "text", placeholder: "Cloudflare" },
      { key: "user", label: "Account email", kind: "text" },
    ],
  },
];

const statusLabel = (status: ProjectAccessMethod["status"]) =>
  status === "available" ? "Connected" : status === "stale" ? "Needs attention" : "Not connected";

const formatVerified = (stamp: string) => {
  if (!stamp || stamp.toLowerCase() === "unknown") return "Not verified yet";
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return stamp;
  return `Last verified ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
};

export function ProjectAccessPanel({
  project,
  canWrite,
  focusTypes = [],
  onBackToConversation,
  onWorkspaceUpdate,
  onAccessEvent,
}: Props) {
  const [editing, setEditing] = useState<{ type: AccessType; existingId?: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const staging = useMemo(
    () => project.environments.find((environment) => environment.type === "staging") ?? null,
    [project.environments],
  );

  const methodFor = (type: AccessType) => project.accessMethods.find((method) => method.type === type) ?? null;

  const run = async (work: () => Promise<Organization>, message: string, event?: AccessEvent) => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      onWorkspaceUpdate(await work());
      setNotice(message);
      // Access persistence has already succeeded. History is best-effort and
      // must never undo or block the access change.
      if (event) {
        try {
          onAccessEvent?.(event);
        } catch {
          // Ignored on purpose.
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const submitConnection = async () => {
    if (!editing) return;
    const definition = CONNECTION_TYPES.find((item) => item.type === editing.type);
    if (!definition) return;

    const existing = editing.existingId ? project.accessMethods.find((item) => item.id === editing.existingId) : null;
    const detail = [values.host, values.user].filter(Boolean).join(" · ");

    // Real credentials never touch project state. They are sealed server-side
    // first, and only a reference plus non-secret metadata is stored here.
    let credentialReference: string | undefined;
    if (definition.executable) {
      const username = (values.user ?? "").trim();
      const secret = values.secret ?? "";
      if (!username || secret.trim().length < 8) {
        setNotice("I need the WordPress username and a complete Application Password.");
        return;
      }

      setBusy(true);
      let stored: Awaited<ReturnType<typeof submitCredential>>;
      try {
        stored = await submitCredential({
          projectId: project.id,
          accessType: "wordpress_admin",
          username,
          secret,
        });
      } finally {
        // Drop the value from component state before anything else happens.
        setValues({});
        setBusy(false);
      }

      if (!stored.ok) {
        setNotice(stored.summary);
        return;
      }
      credentialReference = stored.secretReference;
    }

    const method: ProjectAccessMethod = {
      id: existing?.id ?? `access-${project.id}-${definition.type}-${Date.now()}`,
      type: definition.type,
      label: definition.label,
      status: "available",
      authMethod: definition.authMethod,
      lastVerifiedAt: new Date().toISOString(),
      notes: detail || existing?.notes || "Connection details shared by the site owner.",
      ...(credentialReference ? { credentialReference } : {}),
    };

    await run(
      () => workspaceRepository.saveAccessMethod(project.id, method),
      definition.executable
        ? `${definition.label} is connected. The password is stored securely and can never be read back.`
        : `${definition.label} connection details saved.`,
      { type: definition.type, label: definition.label, action: existing ? "replaced" : "added" },
    );

    setValues({});
    setEditing(null);
  };

  const activeDefinition = editing ? CONNECTION_TYPES.find((item) => item.type === editing.type) ?? null : null;

  return (
    <div className="access-surface">
      <header className="access-head">
        <button className="create-back" type="button" onClick={onBackToConversation}>
          Back to conversation
        </button>
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div>
          <p className="eyebrow">Access &amp; Connections</p>
          <h1>{project.name}</h1>
          <small>{project.primaryDomain}</small>
        </div>
      </header>

      <p className="access-intro">
        Share only what the agent needs. A WordPress Application Password is sealed on the server the moment you save
        it and can never be read back — not by you, not by the agent, not by this page. The other connections record
        where access lives; their credentials aren't stored here yet.
      </p>

      {notice ? <p className="access-notice">{notice}</p> : null}

      <div className="access-grid">
        {CONNECTION_TYPES.map((definition) => {
          const method = methodFor(definition.type);
          const status = method?.status ?? "missing";
          const focused = focusTypes.includes(definition.type) && !method;

          return (
            <article key={definition.type} className={`access-card is-${status} ${focused ? "is-focused" : ""}`}>
              <div className="access-card-head">
                <h3>{definition.label}</h3>
                <span className={`access-status is-${status}`}>{statusLabel(status)}</span>
              </div>
              <p>{method?.notes || definition.blurb}</p>
              {method ? <small className="access-stamp">{formatVerified(method.lastVerifiedAt)}</small> : null}
              {focused ? <small className="access-stamp is-focus">The agent asked for this one.</small> : null}

              <div className="access-card-actions">
                {method ? (
                  <>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={!canWrite || busy}
                      onClick={() =>
                        void run(
                          () => workspaceRepository.verifyAccessMethod(project.id, method.id),
                          `${definition.label} reverified.`,
                          { type: definition.type, label: definition.label, action: "reverified" },
                        )
                      }
                    >
                      Reverify
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={!canWrite || busy}
                      onClick={() => {
                        setValues({});
                        setEditing({ type: definition.type, existingId: method.id });
                      }}
                    >
                      Replace access
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={!canWrite || busy}
                      onClick={() =>
                        void run(
                          () => workspaceRepository.removeAccessMethod(project.id, method.id),
                          `${definition.label} removed.`,
                          { type: definition.type, label: definition.label, action: "removed" },
                        )
                      }
                    >
                      Remove access
                    </button>
                  </>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!canWrite || busy}
                    onClick={() => {
                      setValues({});
                      setEditing({ type: definition.type });
                    }}
                  >
                    Add access
                  </button>
                )}
              </div>
            </article>
          );
        })}

        <article className="access-card is-environment">
          <div className="access-card-head">
            <h3>Staging environment</h3>
            <span className={`access-status is-${staging ? "available" : "missing"}`}>
              {staging ? "Connected" : "Not connected"}
            </span>
          </div>
          <p>
            {staging
              ? `${staging.primaryUrl} · linked to ${project.primaryDomain} for safe rehearsal before production changes.`
              : "No staging environment linked yet. The agent will treat production as the only environment."}
          </p>
          {staging ? <small className="access-stamp">{staging.notes || "Environment metadata on file."}</small> : null}
        </article>
      </div>

      {editing && activeDefinition ? (
        <div className="access-drawer-scrim" role="presentation" onClick={() => setEditing(null)}>
          <div
            className="access-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${activeDefinition.label}`}
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{editing.existingId ? "Replace" : "Add"} {activeDefinition.label}</h2>
            <p className="access-drawer-note">
              {activeDefinition.executable
                ? "The password is sent straight to the secure store and is never shown again."
                : "Connection details only. Don't paste a password here — it wouldn't be stored securely yet."}
            </p>

            {activeDefinition.fields.map((field) => (
              <label key={field.key} className="access-field">
                <span>{field.label}</span>
                <input
                  type={field.kind === "secret" ? "password" : "text"}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                />
                {field.hint ? <small className="access-field-hint">{field.hint}</small> : null}
              </label>
            ))}

            <p className="access-drawer-note">
              {activeDefinition.executable
                ? "You can revoke this Application Password in WordPress at any time, without changing your login."
                : "Deeper server access will get the same secure treatment as WordPress Admin before it goes live."}
            </p>

            <div className="access-drawer-actions">
              <button className="ghost-button" type="button" onClick={() => { setEditing(null); setValues({}); }}>
                Cancel
              </button>
              <button className="primary-button" type="button" disabled={!canWrite || busy} onClick={() => void submitConnection()}>
                Save connection
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
