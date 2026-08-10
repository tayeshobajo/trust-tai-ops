import { useMemo, useState } from "react";
import type { AccessType, Organization, Project, ProjectAccessMethod } from "./types";
import { workspaceRepository } from "./repository";
import { getProjectInitials } from "./home";

type Props = {
  project: Project;
  canWrite: boolean;
  focusTypes?: AccessType[];
  onBackToConversation: () => void;
  onWorkspaceUpdate: (next: Organization) => void;
};

type FieldKind = "text" | "secret";
type Field = { key: string; label: string; kind: FieldKind; placeholder?: string };

const CONNECTION_TYPES: Array<{
  type: AccessType;
  label: string;
  blurb: string;
  authMethod: string;
  fields: Field[];
}> = [
  {
    type: "wordpress_admin",
    label: "WordPress Admin",
    blurb: "The usual first door for diagnosis and plugin-level checks.",
    authMethod: "Administrator login",
    fields: [
      { key: "url", label: "Login URL", kind: "text", placeholder: "https://example.com/wp-admin" },
      { key: "user", label: "Username or email", kind: "text" },
      { key: "secret", label: "Password", kind: "secret" },
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
      { key: "secret", label: "Password", kind: "secret" },
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
      { key: "secret", label: "Key or password", kind: "secret" },
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
      { key: "secret", label: "Password", kind: "secret" },
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
      { key: "secret", label: "Database password", kind: "secret" },
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
      { key: "secret", label: "API token", kind: "secret" },
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

  const run = async (work: () => Promise<Organization>, message: string) => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      onWorkspaceUpdate(await work());
      setNotice(message);
    } finally {
      setBusy(false);
    }
  };

  const submitConnection = async () => {
    if (!editing) return;
    const definition = CONNECTION_TYPES.find((item) => item.type === editing.type);
    if (!definition) return;

    const existing = editing.existingId ? project.accessMethods.find((item) => item.id === editing.existingId) : null;
    const detail = [values.url, values.host, values.user].filter(Boolean).join(" · ");

    const method: ProjectAccessMethod = {
      id: existing?.id ?? `access-${project.id}-${definition.type}-${Date.now()}`,
      type: definition.type,
      label: definition.label,
      status: "available",
      authMethod: definition.authMethod,
      lastVerifiedAt: new Date().toISOString(),
      notes: detail || existing?.notes || "Connection details shared by the site owner.",
    };

    await run(
      () => workspaceRepository.saveAccessMethod(project.id, method),
      `${definition.label} is connected. Secrets are not shown again.`,
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
        Share only what the agent needs. Credential storage will be connected to the secure vault layer before
        production use, so treat this as connection state rather than a credential store.
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
                      onClick={() => void run(() => workspaceRepository.verifyAccessMethod(project.id, method.id), `${definition.label} reverified.`)}
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
                      onClick={() => void run(() => workspaceRepository.removeAccessMethod(project.id, method.id), `${definition.label} removed.`)}
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
              Secrets are masked and are never displayed again after you save.
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
              </label>
            ))}

            <p className="access-drawer-note">
              Credential storage will be connected to the secure vault layer before production use.
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
