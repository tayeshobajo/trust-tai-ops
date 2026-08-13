import type { Dispatch, SetStateAction } from "react";
import type { ProjectDraft } from "./types";

export function CreateProjectPage({
  canCreateProject,
  draft,
  isCreating = false,
  onBack,
  onCreateProject,
  onDraftChange,
  saveMessage,
}: {
  canCreateProject: boolean;
  draft: ProjectDraft;
  isCreating?: boolean;
  onBack: () => void;
  onCreateProject: () => void;
  onDraftChange: Dispatch<SetStateAction<ProjectDraft>>;
  saveMessage: string;
}) {
  const canSubmit =
    canCreateProject && !isCreating && draft.name.trim().length > 0 && draft.websiteUrl.trim().length > 0;

  return (
    <div className="create-page">
      <div className="create-page-inner">
        <button className="create-back" type="button" onClick={onBack}>
          Back to Projects
        </button>

        <header className="create-hero">
          <p className="eyebrow">New Project</p>
          <h1>Create a project</h1>
          <p>Give me the website and I’ll figure out the rest.</p>
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
            <span>Anything I should know? <em>Optional</em></span>
            <textarea
              rows={4}
              value={draft.description}
              placeholder="Add context, current issues, or anything unusual about the site..."
              onChange={(event) => onDraftChange((current) => ({ ...current, description: event.target.value }))}
            />
          </label>

          <div className="create-actions">
            <button className="primary-button" type="submit" disabled={!canSubmit}>
              {isCreating ? "Creating…" : "Create project"}
            </button>
            <button className="ghost-button" type="button" onClick={onBack}>
              Cancel
            </button>
          </div>

          <p className="create-note">
            You can add WordPress, hosting, SSH, and other access after the project is created.
          </p>

          {!canCreateProject ? <p className="create-note">Project creation needs an operator role above viewer.</p> : null}
          {saveMessage ? <p className="create-note">{saveMessage}</p> : null}
        </form>
      </div>
    </div>
  );
}
