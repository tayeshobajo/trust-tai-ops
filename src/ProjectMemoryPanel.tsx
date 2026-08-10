import { useState } from "react";
import type { MemoryEntry, Organization, Project } from "./types";
import { workspaceRepository } from "./repository";
import { getProjectInitials } from "./home";
import {
  HUMAN_MEMORY_KINDS,
  groupMemory,
  importanceLabel,
  memoryTypeLabel,
  openRecommendations,
  projectUnderstanding,
} from "./memory";

type Props = {
  project: Project;
  canWrite: boolean;
  onBackToConversation: () => void;
  onWorkspaceUpdate: (next: Organization) => void;
};

export function ProjectMemoryPanel({ project, canWrite, onBackToConversation, onWorkspaceUpdate }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState(HUMAN_MEMORY_KINDS[0].id);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const sections = groupMemory(project);
  const overview = projectUnderstanding(project);
  const recommendations = openRecommendations(project);
  const environments = project.environments;
  const hasAnything = project.memoryEntries.length > 0 || environments.length > 0 || recommendations.length > 0;

  const saveNote = async () => {
    if (!canWrite || busy || !title.trim() || !content.trim()) return;
    const selected = HUMAN_MEMORY_KINDS.find((item) => item.id === kind) ?? HUMAN_MEMORY_KINDS[0];
    setBusy(true);
    try {
      const next = await workspaceRepository.addMemoryEntry(project.id, {
        title: title.trim(),
        type: selected.type,
        importance: "high",
        content: `${content.trim()} (Noted by the site owner.)`,
      });
      onWorkspaceUpdate(next);
      setNotice("Saved. The agent will use this on future tasks.");
      setTitle("");
      setContent("");
      setDrawerOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const renderEntry = (entry: MemoryEntry) => (
    <li key={entry.id} className="mem-entry">
      <div className="mem-entry-head">
        <strong>{entry.title}</strong>
        <span className={`mem-weight is-${entry.importance}`}>{importanceLabel(entry.importance)}</span>
      </div>
      <p>{entry.content}</p>
      <small>{memoryTypeLabel(entry.type)}</small>
    </li>
  );

  return (
    <div className="access-surface">
      <header className="access-head">
        <button className="create-back" type="button" onClick={onBackToConversation}>
          Back to conversation
        </button>
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div>
          <p className="eyebrow">What I know about this project</p>
          <h1>{project.name}</h1>
          <small>{project.primaryDomain}</small>
        </div>
      </header>

      {notice ? <p className="access-notice">{notice}</p> : null}

      {overview ? (
        <p className="mem-overview">{overview.content}</p>
      ) : (
        <p className="access-intro">
          Everything here is what the agent has learned while working on this site. It carries over between tasks.
        </p>
      )}

      <div className="mem-actions">
        <button className="ghost-button" type="button" disabled={!canWrite} onClick={() => setDrawerOpen(true)}>
          Add project note
        </button>
      </div>

      {!hasAnything ? (
        <p className="mem-empty">The agent has not learned anything durable about this site yet. Add a note if there is something it should always keep in mind.</p>
      ) : null}

      {environments.length > 0 ? (
        <section className="mem-section">
          <h2>Environment and hosting</h2>
          <ul className="mem-list">
            {environments.map((environment) => (
              <li key={environment.id} className="mem-entry">
                <div className="mem-entry-head">
                  <strong>{environment.name}</strong>
                  <span className="mem-weight is-medium">{environment.type === "production" ? "Live site" : environment.type === "staging" ? "Staging" : "Development"}</span>
                </div>
                <p>
                  {[
                    environment.primaryUrl,
                    environment.hostingProvider ? `hosted with ${environment.hostingProvider}` : "",
                    environment.wordpressVersion ? `WordPress ${environment.wordpressVersion}` : "",
                    environment.phpVersion ? `PHP ${environment.phpVersion}` : "",
                    environment.cacheLayers.length > 0 ? `caching: ${environment.cacheLayers.join(", ")}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {environment.notes ? <small>{environment.notes}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.map((section) => (
        <section key={section.id} className="mem-section">
          <h2>{section.title}</h2>
          <p className="mem-blurb">{section.blurb}</p>
          <ul className="mem-list">{section.entries.map(renderEntry)}</ul>
        </section>
      ))}

      {recommendations.length > 0 ? (
        <section className="mem-section">
          <h2>Still recommended</h2>
          <ul className="mem-list">
            {recommendations.map((item) => (
              <li key={item.id} className="mem-entry">
                <div className="mem-entry-head">
                  <strong>{item.title}</strong>
                  <span className={`mem-weight is-${item.priority}`}>{item.priority === "critical" ? "Always apply" : item.priority === "high" ? "Important" : "Good to know"}</span>
                </div>
                <p>{item.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {drawerOpen ? (
        <div className="access-drawer-scrim" role="presentation" onClick={() => setDrawerOpen(false)}>
          <div
            className="access-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Add project note"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>Add project note</h2>
            <p className="access-drawer-note">Tell the agent something it should remember for every future task on this site.</p>

            <label className="access-field">
              <span>Title</span>
              <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Never touch the checkout plugin" />
            </label>

            <label className="access-field">
              <span>What the agent should remember</span>
              <textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} />
            </label>

            <div className="mem-kind-row" role="group" aria-label="Note kind">
              {HUMAN_MEMORY_KINDS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mem-kind ${item.id === kind ? "is-selected" : ""}`}
                  onClick={() => setKind(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="access-drawer-actions">
              <button className="ghost-button" type="button" onClick={() => setDrawerOpen(false)}>
                Cancel
              </button>
              <button className="primary-button" type="button" disabled={!canWrite || busy || !title.trim() || !content.trim()} onClick={() => void saveNote()}>
                Save note
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
