import type { Dispatch, SetStateAction } from "react";
import { accessTypeCopy } from "./data";
import type { ProjectDraft } from "./types";

const accessInitials: Record<ProjectDraft["accessSelections"][number]["type"], string> = {
  wordpress_admin: "WP",
  sftp: "SF",
  ssh: "SH",
  hosting_portal: "HO",
  database: "DB",
  cdn: "CD",
};

// Only these four are offered during initial project creation. Database and
// CDN/Cloudflare stay in the domain model but are added later from Access & Connections.
const visibleAccessTypes: ProjectDraft["accessSelections"][number]["type"][] = [
  "wordpress_admin",
  "sftp",
  "ssh",
  "hosting_portal",
];

export function CreateProjectPage({
  canCreateProject,
  draft,
  onBack,
  onCreateProject,
  onDraftChange,
  saveMessage,
}: {
  canCreateProject: boolean;
  draft: ProjectDraft;
  onBack: () => void;
  onCreateProject: () => void;
  onDraftChange: Dispatch<SetStateAction<ProjectDraft>>;
  saveMessage: string;
}) {
  const canSubmit = canCreateProject && draft.name.trim().length > 0 && draft.websiteUrl.trim().length > 0;

  return (
    <div className="create-page">
      <div className="create-page-inner">
        <button className="create-back" type="button" onClick={onBack}>
          Back to Projects
        </button>

        <header className="create-hero">
          <p className="eyebrow">New Project</p>
          <h1>Create a project</h1>
          <p>
            Just the basics. The agent will discover hosting, WordPress details, and the rest of the technical picture
            on its own.
          </p>
        </header>

        <form
          className="create-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              onCreateProject();
            }
          }}
        >
          <label className="create-field">
            <span>Project name</span>
            <input
              value={draft.name}
              required
              placeholder="Real Leaders Website"
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, name: event.target.value, clientName: event.target.value }))
              }
            />
          </label>

          <label className="create-field">
            <span>Website URL</span>
            <input
              value={draft.websiteUrl}
              required
              placeholder="https://realleaders.com"
              onChange={(event) => onDraftChange((current) => ({ ...current, websiteUrl: event.target.value }))}
            />
          </label>

          <label className="create-field">
            <span>Anything the agent should know? <em>Optional</em></span>
            <textarea
              rows={4}
              value={draft.description}
              placeholder="What should the agent know about this site?"
              onChange={(event) => onDraftChange((current) => ({ ...current, description: event.target.value }))}
            />
          </label>

          <section className="create-access">
            <div className="create-access-head">
              <h2>Access connections</h2>
              <p>Optional. Add what you already have — the agent will ask for anything else when it needs it.</p>
            </div>

            <div className="create-access-grid">
              {visibleAccessTypes.map((type) => {
                const selection = draft.accessSelections.find((item) => item.type === type) ?? {
                  type,
                  enabled: false,
                };
                const copy = accessTypeCopy[selection.type];

                return (
                  <button
                    key={selection.type}
                    type="button"
                    className={`create-access-card ${selection.enabled ? "is-enabled" : ""}`}
                    aria-pressed={selection.enabled}
                    onClick={() =>
                      onDraftChange((current) => ({
                        ...current,
                        accessSelections: current.accessSelections.some((item) => item.type === type)
                          ? current.accessSelections.map((item) =>
                              item.type === type ? { ...item, enabled: !item.enabled } : item,
                            )
                          : [...current.accessSelections, { type, enabled: true }],
                      }))
                    }
                  >
                    <span className="create-access-mark">{accessInitials[selection.type]}</span>
                    <span className="create-access-label">
                      <strong>{copy.label}</strong>
                      <small>{selection.enabled ? "Added" : "Add"}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="create-actions">
            <button className="primary-button" type="submit" disabled={!canSubmit}>
              Create Project
            </button>
            <button className="ghost-button" type="button" onClick={onBack}>
              Cancel
            </button>
          </div>

          {!canCreateProject ? <p className="create-note">Project creation needs an operator role above viewer.</p> : null}
          {saveMessage ? <p className="create-note">{saveMessage}</p> : null}
        </form>
      </div>
    </div>
  );
}
