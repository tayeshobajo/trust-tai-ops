import { useMemo, useState } from "react";
import type { AuthState, Organization, Project } from "./types";
import {
  HUMAN_PHASES,
  formatActivityStamp,
  getActivityTimestamp,
  getMemoryHighlights,
  getProjectInitials,
  getProjectSignal,
  getRecentActivity,
  sortProjectsByActivity,
} from "./home";

type Filter = "all" | "needs_you" | "active";

type Props = {
  workspace: Organization;
  authState: AuthState;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
  onCreateProject: () => void;
  onNewTask: (projectId: string) => void;
};

const navItems = [
  { id: "projects", label: "Projects" },
  { id: "activity", label: "Activity" },
  { id: "team", label: "Team" },
  { id: "settings", label: "Settings" },
] as const;

const agentStateCopy = {
  ready: "Agent ready",
  working: "Agent working",
  needs_you: "Needs you",
} as const;

export function ProjectsCommandCenter({
  workspace,
  authState,
  selectedProjectId,
  onSelectProject,
  onOpenProject,
  onCreateProject,
  onNewTask,
}: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [mobilePreview, setMobilePreview] = useState(false);

  const ordered = useMemo(() => sortProjectsByActivity(workspace.projects), [workspace.projects]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();

    return ordered.filter((project) => {
      const signal = getProjectSignal(project);

      if (filter === "needs_you" && signal.agentState !== "needs_you") {
        return false;
      }

      if (filter === "active" && signal.agentState !== "working") {
        return false;
      }

      if (!term) {
        return true;
      }

      return `${project.name} ${project.primaryDomain} ${project.clientName}`.toLowerCase().includes(term);
    });
  }, [ordered, filter, query]);

  const selected = workspace.projects.find((project) => project.id === selectedProjectId) ?? ordered[0] ?? null;
  const operator = authState.userEmail ?? "Operator";

  return (
    <div className={`home-shell ${mobilePreview ? "is-preview" : ""}`}>
      <nav className="global-rail" aria-label="Primary">
        <div className="global-rail-brand">
          <img src="/trust-tai-logo-white.png" alt="Trust Tai" />
        </div>
        <ul className="global-rail-nav">
          {navItems.map((item) => (
            <li key={item.id}>
              <button className={`global-rail-link ${item.id === "projects" ? "is-active" : ""}`} type="button">
                <span className="global-rail-dot" aria-hidden="true" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="global-rail-operator">
          <span className="global-rail-avatar" aria-hidden="true">
            {operator.slice(0, 1).toUpperCase()}
          </span>
          <small>{operator}</small>
        </div>
      </nav>

      <section className="inbox-column" aria-label="Projects">
        <header className="inbox-head">
          <div className="inbox-title">
            <p className="eyebrow">Command Center</p>
            <h1>Projects</h1>
          </div>
          <button className="primary-button" type="button" onClick={onCreateProject}>
            Create Project
          </button>
        </header>

        <div className="inbox-controls">
          <input
            className="inbox-search"
            type="search"
            value={query}
            placeholder="Search projects"
            aria-label="Search projects"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="inbox-filters" role="tablist" aria-label="Project filters">
            {([
              ["all", "All"],
              ["needs_you", "Needs You"],
              ["active", "Active"],
            ] as Array<[Filter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={`inbox-filter ${filter === value ? "is-active" : ""}`}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="inbox-list">
          {visible.length === 0 ? (
            <div className="inbox-empty">
              <h2>{workspace.projects.length === 0 ? "No projects yet" : "Nothing here"}</h2>
              <p>
                {workspace.projects.length === 0
                  ? "Start with a website and the access you have. The agent will ask for whatever else it needs."
                  : "Try a different search or filter."}
              </p>
              {workspace.projects.length === 0 ? (
                <button className="primary-button" type="button" onClick={onCreateProject}>
                  Create Project
                </button>
              ) : null}
            </div>
          ) : (
            visible.map((project) => {
              const signal = getProjectSignal(project);
              const isSelected = project.id === selected?.id;

              return (
                <button
                  key={project.id}
                  type="button"
                  className={`inbox-row ${isSelected ? "is-selected" : ""}`}
                  onClick={() => {
                    onSelectProject(project.id);
                    setMobilePreview(true);
                  }}
                >
                  <span className="inbox-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
                  <span className="inbox-row-body">
                    <span className="inbox-row-top">
                      <strong>{project.name}</strong>
                      <small>{formatActivityStamp(getActivityTimestamp(project))}</small>
                    </span>
                    <span className="inbox-row-domain">{project.primaryDomain}</span>
                    <span className="inbox-row-status">{signal.status}</span>
                  </span>
                  {signal.agentState === "needs_you" ? <span className="inbox-dot" aria-label="Needs you" /> : null}
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="preview-column" aria-label="Project preview">
        {selected ? (
          <ProjectPreview
            project={selected}
            onBack={() => setMobilePreview(false)}
            onOpenProject={() => onOpenProject(selected.id)}
            onNewTask={() => onNewTask(selected.id)}
          />
        ) : (
          <div className="preview-empty">
            <p className="eyebrow">Trust Tai Ops</p>
            <h2>A quiet place for your sites</h2>
            <p>
              Create a project, describe what is happening in plain English, and the agent handles the engineering work
              from there.
            </p>
            <button className="primary-button" type="button" onClick={onCreateProject}>
              Create Project
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ProjectPreview({
  project,
  onBack,
  onOpenProject,
  onNewTask,
}: {
  project: Project;
  onBack: () => void;
  onOpenProject: () => void;
  onNewTask: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const signal = getProjectSignal(project);
  const activity = getRecentActivity(project);
  const memory = getMemoryHighlights(project);
  const phaseIndex = signal.phase ? HUMAN_PHASES.indexOf(signal.phase) : -1;

  return (
    <article className="preview-panel">
      <header className="preview-head">
        <button className="preview-back" type="button" onClick={onBack}>
          Back
        </button>
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div className="preview-identity">
          <h2>{project.name}</h2>
          <a href={`https://${project.primaryDomain}`} target="_blank" rel="noreferrer">
            {project.primaryDomain} <span aria-hidden="true">↗</span>
          </a>
        </div>
        <span className={`agent-state agent-state-${signal.agentState}`}>{agentStateCopy[signal.agentState]}</span>
      </header>

      <p className="preview-intro">
        {project.memoryEntries[0]?.content ?? `${project.clientName} on ${project.primaryDomain}. The agent keeps what it learns here between tasks.`}
      </p>

      <section className="preview-status">
        <p className="eyebrow">Current status</p>
        <h3>{signal.status}</h3>
        <p>{signal.detail}</p>
      </section>

      <ol className="phase-track" aria-label="Progress">
        {HUMAN_PHASES.map((phase, index) => (
          <li
            key={phase}
            className={`phase-step ${index < phaseIndex ? "is-done" : ""} ${index === phaseIndex ? "is-current" : ""}`}
          >
            <span className="phase-dot" aria-hidden="true" />
            {phase}
          </li>
        ))}
      </ol>

      <div className="preview-cards">
        <section className="preview-card">
          <p className="eyebrow">What the agent needs</p>
          <p>{signal.needsYou ?? "Nothing right now."}</p>
        </section>
        <section className="preview-card">
          <p className="eyebrow">Recent activity</p>
          {activity.length === 0 ? <p>No activity yet.</p> : (
            <ul>
              {activity.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          )}
        </section>
        <section className="preview-card">
          <p className="eyebrow">
            Project memory
            {project.memoryEntries.length > 0 ? ` · ${project.memoryEntries.length} things known` : ""}
          </p>
          {memory.length === 0 ? <p>The agent has not learned anything durable yet.</p> : (
            <ul>
              {memory.map((entry) => <li key={entry.id}>{entry.title}</li>)}
            </ul>
          )}
        </section>
      </div>

      <footer className="preview-actions">
        <button className="primary-button" type="button" onClick={onOpenProject}>
          Open Project
        </button>
        <button className="ghost-button" type="button" onClick={onNewTask}>
          New Task
        </button>
        <div className="preview-menu">
          <button className="icon-button" type="button" aria-label="More options" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            ···
          </button>
          {menuOpen ? (
            <div className="preview-menu-list" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenProject(); }}>Open project</button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNewTask(); }}>Start a new task</button>
              <a role="menuitem" href={`https://${project.primaryDomain}`} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Visit website</a>
            </div>
          ) : null}
        </div>
      </footer>
    </article>
  );
}
