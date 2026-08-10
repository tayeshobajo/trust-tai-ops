import { useState } from "react";
import type { Project } from "./types";
import { getProjectInitials } from "./home";

const starterPrompts = [
  "Investigate a website issue",
  "Improve website speed",
  "Check for malware",
  "Build or update a feature",
  "Run website QA",
];

const secondaryNav = ["Conversation", "Tasks", "Memory", "Access", "Activity"] as const;

export function ProjectEmptyState({
  project,
  onBackToProjects,
  onSubmitBrief,
  onOpenAccess,
}: {
  project: Project;
  onBackToProjects: () => void;
  onSubmitBrief: (brief: string) => Promise<void> | void;
  onOpenAccess?: () => void;
}) {
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const accessCount = project.accessMethods.length;

  const send = () => {
    const value = message.trim();

    if (!value || busy) {
      return;
    }

    setSent((current) => [...current, value]);
    setMessage("");
    setBusy(true);
    void Promise.resolve(onSubmitBrief(value)).finally(() => setBusy(false));
  };

  return (
    <div className="project-empty">
      <header className="project-empty-head">
        <button className="create-back" type="button" onClick={onBackToProjects}>
          Projects
        </button>
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div className="project-empty-identity">
          <h1>{project.name}</h1>
          <a href={`https://${project.primaryDomain}`} target="_blank" rel="noreferrer">
            {project.primaryDomain} <span aria-hidden="true">↗</span>
          </a>
        </div>
        <span className="agent-state">Agent ready</span>
      </header>

      <nav className="project-subnav" aria-label="Project sections">
        {secondaryNav.map((item) => (
          <button
            key={item}
            type="button"
            className={`project-subnav-link ${item === "Conversation" ? "is-active" : ""}`}
            onClick={item === "Access" ? onOpenAccess : undefined}
          >
            {item}
          </button>
        ))}
        <span className="project-subnav-meta">
          {project.memoryEntries.length > 0 ? "Project memory active" : "Memory is starting"}
          {" · "}
          {accessCount > 0 ? `${accessCount} access ${accessCount === 1 ? "path" : "paths"} shared` : "No access shared yet"}
        </span>
      </nav>

      <main className="conversation-surface">
        {sent.length === 0 ? (
          <div className="conversation-intro">
            <h2>Your project is ready.</h2>
            <p>Tell me what you would like me to investigate, fix, improve, or build. I&apos;ll guide the rest.</p>
          </div>
        ) : (
          <div className="conversation-thread">
            {sent.map((entry, index) => (
              <p key={index} className="conversation-bubble">{entry}</p>
            ))}
          </div>
        )}

        <div className="composer">
          <textarea
            className="composer-input"
            rows={3}
            value={message}
            placeholder="Describe the issue, task, or outcome you want help with..."
            aria-label="Message the agent"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <button className="composer-attach" type="button" aria-label="Attach a file">＋</button>
            <button className="primary-button" type="button" onClick={send} disabled={!message.trim() || busy}>
              Send
            </button>
          </div>
        </div>

        <div className="starter-prompts">
          {starterPrompts.map((prompt) => (
            <button key={prompt} type="button" className="starter-prompt" onClick={() => setMessage(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
