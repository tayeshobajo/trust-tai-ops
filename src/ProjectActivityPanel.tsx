import { useEffect, useState } from "react";
import type { Project, ProjectMessage } from "./types";
import { getProjectInitials } from "./home";
import { buildTaskDetail, buildTaskHistory, buildTechnicalDetail } from "./activity";
import { countMessagesForRun } from "./messages";
import { workspaceRepository } from "./repository";

type Props = {
  project: Project;
  onBackToConversation: () => void;
};

const formatDay = (stamp: string) => {
  if (!stamp) return "";
  const match = stamp.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return stamp;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

export function ProjectActivityPanel({ project, onBackToConversation }: Props) {
  const history = buildTaskHistory(project);
  const [openId, setOpenId] = useState<string | null>(history[0]?.run.id ?? null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [messages, setMessages] = useState<ProjectMessage[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stored = await workspaceRepository.listProjectMessages(project.id);
        if (alive) setMessages(stored);
      } catch {
        if (alive) setMessages([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.id]);

  return (
    <div className="access-surface">
      <header className="access-head">
        <button className="create-back" type="button" onClick={onBackToConversation}>
          Back to conversation
        </button>
        <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
        <div>
          <p className="eyebrow">What happened on this project</p>
          <h1>{project.name}</h1>
          <small>{project.primaryDomain}</small>
        </div>
      </header>

      {history.length === 0 ? (
        <p className="mem-empty">Nothing has happened yet. Once you ask the agent for something, every task will be recorded here.</p>
      ) : null}

      <ol className="act-list">
        {history.map((task) => {
          const isOpen = task.run.id === openId;
          const sections = isOpen ? buildTaskDetail(task.run) : [];
          const technical = isOpen ? buildTechnicalDetail(task.run) : [];
          const messageCount = countMessagesForRun(messages, task.run.id);

          return (
            <li key={task.run.id} className={`act-item ${isOpen ? "is-open" : ""}`}>
              <button
                type="button"
                className="act-row"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpenId(isOpen ? null : task.run.id);
                  setShowTechnical(false);
                }}
              >
                <div className="act-row-top">
                  <strong>{task.title}</strong>
                  <span className="act-stamp">{formatDay(task.stamp)}</span>
                </div>
                <p>{task.outcome}</p>
                <div className="act-tags">
                  {task.qaLabel && !task.isActive ? <span className="act-tag">{task.qaLabel}</span> : null}
                  {task.needsYou ? <span className="act-tag is-attention">Waiting on you</span> : null}
                  {task.isActive && !task.needsYou ? <span className="act-tag is-live">In progress</span> : null}
                </div>
              </button>

              {isOpen ? (
                <div className="act-detail">
                  {sections.map((section) => (
                    <section key={section.id} className="act-detail-block">
                      <h3>{section.title}</h3>
                      <ul>
                        {section.lines.map((line, index) => (
                          <li key={index}>{line}</li>
                        ))}
                      </ul>
                    </section>
                  ))}

                  {technical.length > 0 ? (
                    <></>
                  ) : null}
                  {messageCount > 0 ? (
                    <p className="act-conversation">Conversation: {messageCount} {messageCount === 1 ? "message" : "messages"}</p>
                  ) : null}
                  {technical.length > 0 ? (
                    <div className="act-technical">
                      <button type="button" className="ghost-button" onClick={() => setShowTechnical((value) => !value)}>
                        {showTechnical ? "Hide technical details" : "Technical details"}
                      </button>
                      {showTechnical ? (
                        <ul className="act-technical-list">
                          {technical.map((line, index) => (
                            <li key={index}>{line}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
