import { useEffect, useMemo, useState } from "react";
import type { AccessType, Organization, Project, ProjectAccessMethod } from "./types";
import { workspaceRepository } from "./repository";
import { getProjectInitials } from "./home";
import { loadCredentialDetails, submitCredential, verifyStoredCredential } from "./agent-core/secrets";
import { adminCredentialLabel, getProjectStack, stackCopy } from "./stacks";
import { hostGuidance } from "./hostGuidance";
import type { ProjectStack } from "./types";

type Props = {
  project: Project;
  canWrite: boolean;
  focusTypes?: AccessType[];
  onBackToConversation?: () => void;
  // Rendered inside the persistent project shell. The shell already provides
  // navigation, so the panel suppresses its own back control.
  embedded?: boolean;
  onWorkspaceUpdate: (next: Organization) => void;
  // Conversation history only. The panel never passes submitted values here —
  // the event is built from the predefined connection label and the action.
  onAccessEvent?: (event: AccessEvent) => void;
};

export type AccessEventAction = "added" | "replaced" | "reverified" | "removed";
export type AccessEvent = { type: AccessType; label: string; action: AccessEventAction };

type FieldKind = "text" | "secret" | "secret_multiline";
type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
};

type ConnectionDefinition = {
  type: AccessType;
  label: string;
  blurb: string;
  authMethod: string;
  fields: Field[];
  /** True when a real credential can be sealed server-side for this type. */
  executable?: boolean;
};

type AccessNotice = {
  message: string;
  tone: "success" | "warning" | "error";
};

const Notice = ({ notice }: { notice: AccessNotice }) => (
  <div
    className={`access-notice is-${notice.tone}`}
    role={notice.tone === "error" ? "alert" : "status"}
    aria-live={notice.tone === "error" ? "assertive" : "polite"}
  >
    <span className="access-notice-icon" aria-hidden="true">
      {notice.tone === "success" ? "✓" : "!"}
    </span>
    <div>
      <strong>
        {notice.tone === "success"
          ? "Access updated"
          : notice.tone === "error"
            ? "Connection failed"
            : "Action needed"}
      </strong>
      <p>{notice.message}</p>
    </div>
  </div>
);

const CONNECTION_TYPES: ConnectionDefinition[] = [
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
        hint: "WP Admin → Users → Profile → Application Passwords → Add New. Use your normal login password and you'll hit a 2FA wall — Application Passwords bypass that entirely. Copy the password with its spaces.",
      },
      {
        key: "loginUrl",
        label: "Custom admin address",
        kind: "text",
        optional: true,
        placeholder: "/wp-admin or /my-secret-login",
        hint: "Only if this site moved its login away from /wp-login.php. It must be on the same domain.",
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
    authMethod: "SSH private key",
    executable: true,
    fields: [
      { key: "host", label: "Host", kind: "text", placeholder: "example.com" },
      { key: "port", label: "Port", kind: "text", placeholder: "22", optional: true },
      { key: "user", label: "SSH username", kind: "text" },
      {
        key: "secret",
        label: "SSH private key",
        kind: "secret_multiline",
        placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
        hint: "Paste the whole private key file. Use a key created just for this agent so it can be revoked on its own.",
      },
      { key: "passphrase", label: "Key passphrase", kind: "secret", optional: true, hint: "Only if the key is encrypted." },
      {
        key: "wpRoot",
        label: "WordPress folder on the server",
        kind: "text",
        placeholder: "/var/www/html",
        optional: true,
        hint: "Leave blank if WP-CLI already runs from the right place when you log in.",
      },
    ],
  },
  {
    type: "google_search_console",
    label: "Google Search Console",
    blurb: "Search performance data, index coverage, and crawl issues — straight from Google.",
    authMethod: "Service account key",
    executable: true,
    fields: [
      {
        key: "user",
        label: "Service account email",
        kind: "text",
        placeholder: "my-agent@my-project.iam.gserviceaccount.com",
        hint: "The client_email from the JSON key file. The agent uses this to identify itself to Google.",
      },
      {
        key: "secret",
        label: "Service account JSON key",
        kind: "secret_multiline",
        placeholder: '{"type": "service_account", "project_id": "..."}',
        hint: 'Google Cloud Console → IAM & Admin → Service Accounts → your account → Keys → Add Key → JSON. Paste the entire file contents. The agent needs the service account added as a property user in Search Console first.',
      },
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
  {
    type: "server_pm2",
    label: "App process / PM2",
    blurb: "For reading process health, restarts, and app logs.",
    authMethod: "Process manager access",
    fields: [
      { key: "host", label: "Server", kind: "text", placeholder: "app-01.example.com" },
      { key: "user", label: "Process name or user", kind: "text" },
    ],
  },
  {
    type: "ci_cd",
    label: "CI / CD pipeline",
    blurb: "For build history, branch gates, and deploy state.",
    authMethod: "Pipeline account access",
    fields: [
      { key: "host", label: "Provider", kind: "text", placeholder: "GitHub Actions, GitLab CI..." },
      { key: "user", label: "Account or repository", kind: "text" },
    ],
  },
  {
    type: "container",
    label: "Container platform",
    blurb: "For image, service, and orchestration checks.",
    authMethod: "Container platform access",
    fields: [
      { key: "host", label: "Platform", kind: "text", placeholder: "Docker, Kubernetes..." },
      { key: "user", label: "Account or namespace", kind: "text" },
    ],
  },
];

/**
 * WordPress-specific fields and wording only exist on WordPress projects. On
 * any other stack the SSH key can still be sealed and checked against the
 * server's identity — but no command executor exists for it yet, and the
 * interface must not pretend otherwise.
 */
const definitionForStack = (definition: ConnectionDefinition, stack: ProjectStack): ConnectionDefinition => {
  if (definition.type !== "ssh" || stack === "wordpress") return definition;
  return {
    ...definition,
    blurb: "Server-level access. The key is sealed on the server and checked against the server's identity.",
    fields: definition.fields
      .filter((field) => field.key !== "wpRoot")
      .map((field) =>
        field.key === "secret"
          ? {
              ...field,
              hint: "Paste the whole private key file. Use a key created just for this agent so it can be revoked on its own.",
            }
          : field,
      ),
  };
};

/** True only when a real check has ever succeeded. */
const isVerified = (method: ProjectAccessMethod | null): boolean => {
  const stamp = method?.lastVerifiedAt ?? "";
  if (!stamp || stamp.toLowerCase() === "unknown") return false;
  return !Number.isNaN(new Date(stamp).getTime());
};

/** A sealed credential actually exists for this record. */
const hasSealedCredential = (method: ProjectAccessMethod | null): boolean =>
  Boolean(method?.credentialReference);

/**
 * Recorded, stored, and verified are three different facts, and the label says
 * which one is true. A record with no sealed credential is only "Details
 * recorded" — never "Stored securely", never "Verified".
 */
const statusLabel = (method: ProjectAccessMethod | null, executable = false): string => {
  if (!method) return "Not connected";
  if (method.status === "stale") return "Needs attention";
  if (method.status === "missing") return "Not connected";
  // "Verified" is reserved for a credential the provider itself accepted.
  // Details a person typed in are only ever "Confirmed".
  if (!executable) return isVerified(method) ? "Confirmed" : "Connected";
  if (!hasSealedCredential(method)) return "Details recorded";
  return isVerified(method) ? "Verified" : "Stored securely";
};

const formatVerified = (method: ProjectAccessMethod) => {
  if (!isVerified(method)) return "Not verified yet";
  const date = new Date(method.lastVerifiedAt);
  return `Last verified ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
};

export function ProjectAccessPanel({
  project,
  canWrite,
  focusTypes = [],
  onBackToConversation,
  embedded = false,
  onWorkspaceUpdate,
  onAccessEvent,
}: Props) {
  const [editing, setEditing] = useState<{ type: AccessType; existingId?: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  // Anything that goes wrong while the drawer is open must be said inside the
  // drawer — the page-level notice sits behind the scrim and is never seen.
  const [drawerNotice, setDrawerNotice] = useState<AccessNotice | null>(null);
  // Non-secret details only. A secret is never fetched back into the form.
  const [prefilling, setPrefilling] = useState(false);

  const stack = getProjectStack(project);

  const editingType = editing?.type ?? null;
  const editingExisting = editing?.existingId ?? null;

  /**
   * Replacing access shows what was entered before — username, host, paths —
   * so nothing has to be retyped. The credential itself stays unreadable.
   */
  useEffect(() => {
    if (!editingType || !editingExisting) return;
    if (editingType !== "wordpress_admin" && editingType !== "ssh") return;
    let cancelled = false;
    setPrefilling(true);
    void loadCredentialDetails(project.id, editingType)
      .then((details) => {
        if (cancelled || !details) return;
        setValues((current) => ({
          user: current.user ?? details.username,
          host: current.host ?? details.host,
          port: current.port ?? details.port,
          wpRoot: current.wpRoot ?? details.wpRoot,
          loginUrl: current.loginUrl ?? details.loginUrl,
          ...current,
        }));
      })
      .finally(() => {
        if (!cancelled) setPrefilling(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingType, editingExisting, project.id]);

  const copy = stackCopy[stack];
  // Only a stack whose admin credential can genuinely be sealed gets named.
  const adminLabel = adminCredentialLabel(stack);

  /**
   * Only the connections this stack actually uses — plus anything already
   * recorded, so nothing a person shared earlier disappears from view.
   */
  const connectionTypes = useMemo(() => {
    const allowed = new Set<AccessType>(copy.accessTypes);
    for (const method of project.accessMethods) allowed.add(method.type);
    return CONNECTION_TYPES.filter((definition) => allowed.has(definition.type)).map((definition) =>
      definitionForStack(definition, stack),
    );
  }, [copy.accessTypes, project.accessMethods, stack]);

  const staging = useMemo(
    () => project.environments.find((environment) => environment.type === "staging") ?? null,
    [project.environments],
  );

  const methodFor = (type: AccessType) => project.accessMethods.find((method) => method.type === type) ?? null;

  const run = async (work: () => Promise<Organization>, message: string, event?: AccessEvent): Promise<boolean> => {
    if (!canWrite || busy) return false;
    setBusy(true);
    try {
      onWorkspaceUpdate(await work());
      setNotice({ message, tone: "success" });
      // Access persistence has already succeeded. History is best-effort and
      // must never undo or block the access change.
      if (event) {
        try {
          onAccessEvent?.(event);
        } catch {
          // Ignored on purpose.
        }
      }
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      const message = `I couldn't save that connection${detail}. Nothing was changed.`;
      setNotice({ message, tone: "error" });
      setDrawerNotice({ message, tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitConnection = async () => {
    if (!editing) return;
    const definition = CONNECTION_TYPES.find((item) => item.type === editing.type);
    if (!definition) return;
    setDrawerNotice(null);

    const existing = editing.existingId ? project.accessMethods.find((item) => item.id === editing.existingId) : null;
    const detail = [values.host, values.user].filter(Boolean).join(" · ");

    // Real credentials never touch project state. They are sealed server-side
    // first, and only a reference plus non-secret metadata is stored here.
    let credentialReference: string | undefined;
    if (definition.executable) {
      const username = (values.user ?? "").trim();
      const secret = values.secret ?? "";
      const isSsh = definition.type === "ssh";
      const isGsc = definition.type === "google_search_console";

      if (isGsc) {
        if (!username || !username.includes("@")) {
          setDrawerNotice({ message: "I need the service account email address.", tone: "warning" });
          return;
        }
        const trimmed = secret.trim();
        if (!trimmed.startsWith("{") || trimmed.length < 100) {
          setDrawerNotice({
            message: 'Paste the whole JSON key file — it starts with { and contains the private_key field.',
            tone: "warning",
          });
          return;
        }
      } else if (!username || secret.trim().length < 8) {
        setDrawerNotice({
          message: isSsh
            ? "I need the SSH username and the whole private key."
            : "I need the WordPress username and a complete Application Password.",
          tone: "warning",
        });
        return;
      }
      if (isSsh && !(values.host ?? "").trim()) {
        setDrawerNotice({ message: "I need the server address before I can store SSH access.", tone: "warning" });
        return;
      }

      setBusy(true);
      let stored: Awaited<ReturnType<typeof submitCredential>>;
      try {
        stored = await submitCredential({
          projectId: project.id,
          accessType: isGsc ? "google_search_console" : isSsh ? "ssh" : "wordpress_admin",
          username,
          secret,
          ...(isSsh
            ? {
                host: (values.host ?? "").trim(),
                port: Number((values.port ?? "").trim() || 22),
                wpRoot: (values.wpRoot ?? "").trim(),
                passphrase: values.passphrase ?? "",
              }
            : { loginUrl: (values.loginUrl ?? "").trim() }),
        });
      } catch (error) {
        const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
        setValues({});
        setBusy(false);
        setDrawerNotice({ message: `I couldn't reach the secure store${detail}, so nothing was stored.`, tone: "error" });
        return;
      }
      // Drop the key and passphrase from component state immediately.
      setValues({});
      setBusy(false);

      if (!stored.ok) {
        setDrawerNotice({ message: stored.summary, tone: "error" });
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
      // Storing a credential proves nothing about whether it works. The
      // timestamp stays empty until a real server-side check succeeds.
      lastVerifiedAt: definition.executable ? "" : new Date().toISOString(),
      notes: detail || existing?.notes || "Connection details shared by the site owner.",
      ...(credentialReference ? { credentialReference } : {}),
    };

    const saved = await run(
      () => workspaceRepository.saveAccessMethod(project.id, method),
      definition.executable
        ? definition.type === "ssh"
          ? `${definition.label} is stored securely and can never be read back. I haven't connected yet — use Verify access, and I'll record the server's identity on that first connection.`
          : definition.type === "google_search_console"
            ? `${definition.label} service account is stored securely and can never be read back. Use Verify access to confirm the key is accepted and the service account has property access.`
            : `${definition.label} is stored securely and can never be read back. It hasn't been checked with WordPress yet — use Verify access when you're ready.`
        : `${definition.label} connection details saved.`,
      { type: definition.type, label: definition.label, action: existing ? "replaced" : "added" },
    );
    if (!saved) return;

    setValues({});
    setEditing(null);
    setDrawerNotice(null);
  };

  const activeDefinition = editing
    ? (() => {
        const found = CONNECTION_TYPES.find((item) => item.type === editing.type);
        return found ? definitionForStack(found, stack) : null;
      })()
    : null;

  // What this particular host requires, when its process differs from the norm.
  const activeGuidance = activeDefinition ? hostGuidance(project, activeDefinition.type) : null;

  /**
   * A real, server-side, read-only check. The browser sends only the project
   * id: it cannot choose the address, and it cannot write the outcome.
   */
  const verifyExecutable = async (definition: (typeof CONNECTION_TYPES)[number]) => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      const outcome = await verifyStoredCredential(
        project.id,
        definition.type === "ssh"
          ? "ssh"
          : definition.type === "google_search_console"
            ? "google_search_console"
            : "wordpress_admin",
      );
      setNotice({
        message: outcome.summary,
        tone: outcome.state === "verified" ? "success" : outcome.state === "rejected" ? "error" : "warning",
      });
      // The server decided this. The repository reconciles the stored record
      // with the server's outcome — on the native adapter that is a pure
      // re-read, because the function already wrote the row.
      onWorkspaceUpdate(
        await workspaceRepository.applyServerVerification(project.id, definition.type, {
          state: outcome.state,
          lastVerifiedAt: outcome.lastVerifiedAt,
        }),
      );
      if (outcome.state === "verified") {
        try {
          onAccessEvent?.({ type: definition.type, label: definition.label, action: "reverified" });
        } catch {
          // History is best-effort and never undoes a verification.
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`access-surface ${embedded ? "is-embedded" : ""}`}>
      <header className="access-head">
        {!embedded && onBackToConversation ? (
          <button className="create-back" type="button" onClick={onBackToConversation}>
            Back to conversation
          </button>
        ) : null}
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div>
          <p className="eyebrow">Access &amp; Connections</p>
          <h1>{project.name}</h1>
          <small>{project.primaryDomain}</small>
        </div>
      </header>

      <p className="access-intro">
        Share only what the agent needs.{" "}
        {adminLabel ? `A ${adminLabel} credential and an SSH private key are` : "An SSH private key is"} sealed on the
        server the moment you save {adminLabel ? "them" : "it"} and can never be read back — not by you, not by the
        agent, not by this page.{" "}
        {stack === "wordpress"
          ? "SSH is used for a fixed list of read-only inspections only."
          : "SSH is stored and checked against the server's identity; running commands on this stack isn't enabled yet."}{" "}
        The other connections record where access lives; their credentials aren&apos;t stored here yet.
      </p>

      {notice ? <Notice notice={notice} /> : null}

      <div className="access-grid">
        {connectionTypes.map((definition) => {
          const method = methodFor(definition.type);
          const status = method?.status ?? "missing";
          const verified = isVerified(method);
          const focused = focusTypes.includes(definition.type) && !method;

          return (
            <article key={definition.type} className={`access-card is-${status} ${focused ? "is-focused" : ""}`}>
              <div className="access-card-head">
                <h3>{definition.label}</h3>
                <span className={`access-status is-${status}`}>{statusLabel(method, definition.executable)}</span>
              </div>
              <p>{method?.notes || definition.blurb}</p>
              {method ? (
                <small className="access-stamp">
                  {definition.executable && !isVerified(method)
                    ? !hasSealedCredential(method)
                      ? "Details recorded · no credential stored yet"
                      : definition.type === "ssh"
                        ? "Stored securely · server identity not confirmed yet"
                        : "Stored securely · not yet checked with WordPress"
                    : formatVerified(method)}
                </small>
              ) : null}
              {focused ? <small className="access-stamp is-focus">The agent asked for this one.</small> : null}

              <div className="access-card-actions">
                {method ? (
                  <>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={!canWrite || busy}
                      onClick={() =>
                        definition.executable
                          ? void verifyExecutable(definition)
                          : void run(
                              () => workspaceRepository.verifyAccessMethod(project.id, method.id, definition.type),
                              `${definition.label} details confirmed as current.`,
                              { type: definition.type, label: definition.label, action: "reverified" },
                            )
                      }
                    >
                      {definition.executable ? (verified ? "Recheck access" : "Verify access") : "Confirm details"}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={!canWrite || busy}
                      onClick={() => {
                        setValues({});
                        setDrawerNotice(null);
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
                      setDrawerNotice(null);
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
            {drawerNotice ? <Notice notice={drawerNotice} /> : null}
            {prefilling ? <p className="access-drawer-note">Loading the details you saved before…</p> : null}
            {activeGuidance ? (
              <div className="access-host-guide">
                <strong>{activeGuidance.host}</strong>
                <p>{activeGuidance.summary}</p>
                <ol>
                  {activeGuidance.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {activeGuidance.hints ? (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() =>
                      setValues((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          Object.entries(activeGuidance.hints ?? {}).filter(
                            ([key]) => !(current[key] ?? "").trim(),
                          ),
                        ),
                      }))
                    }
                  >
                    Fill in the {activeGuidance.host} details
                  </button>
                ) : null}
              </div>
            ) : null}
            <p className="access-drawer-note">
              {activeDefinition.executable
                ? activeDefinition.type === "ssh"
                  ? stack === "wordpress"
                    ? "The private key is sent straight to the secure store and is never shown again. Only a fixed list of read-only WP-CLI inspections can ever be run with it."
                    : "The private key is sent straight to the secure store and is never shown again. It can be checked against the server's identity; running commands on this stack isn't enabled yet."
                  : activeDefinition.type === "google_search_console"
                    ? "The service account JSON key is sent straight to the secure store and is never shown again. Only read-only Search Console queries are ever run with it."
                    : "The password is sent straight to the secure store and is never shown again."
                : "Connection details only. Don't paste a password here — it wouldn't be stored securely yet."}
            </p>

            {activeDefinition.fields.map((field) => (
              <label key={field.key} className="access-field">
                <span>
                  {field.label}
                  {field.optional ? <em className="access-field-optional"> · optional</em> : null}
                </span>
                {field.kind === "secret_multiline" ? (
                  <textarea
                    className="access-field-key"
                    rows={5}
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                ) : (
                  <input
                    type={field.kind === "secret" ? "password" : "text"}
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                )}
                {field.hint ? <small className="access-field-hint">{field.hint}</small> : null}
              </label>
            ))}

            <p className="access-drawer-note">
              {activeDefinition.executable
                ? activeDefinition.type === "ssh"
                  ? "You can remove this key from the server's authorized_keys at any time. Nothing here can write, install, update, or delete."
                  : "You can revoke this Application Password in WordPress at any time, without changing your login."
                : `Deeper server access will get the same secure treatment as ${adminLabel ?? "SSH"} before it goes live.`}
            </p>

            <div className="access-drawer-actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => { setEditing(null); setValues({}); setDrawerNotice(null); }}
              >
                Cancel
              </button>
              <button className="primary-button" type="button" disabled={!canWrite || busy} onClick={() => void submitConnection()}>
                {busy ? "Saving…" : "Save connection"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
