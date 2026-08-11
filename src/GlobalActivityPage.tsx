import { useState } from "react";
import type { Organization } from "./types";
import { buildGlobalActivity } from "./globalFeed";
import { formatActivityStamp } from "./home";

type Props = {
  workspace: Organization;
  onOpenProject: (projectId: string) => void;
};

export function GlobalActivityPage({ workspace, onOpenProject }: Props) {
  const items = buildGlobalActivity(workspace);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="global-surface">
      <header className="global-surface-head">
        <p className="eyebrow">Across every project</p>
        <h1>Activity</h1>
        <p className="global-surface-lede">
          What the agent has been doing, in the order it happened. Open a project to see the full conversation.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="global-empty">
          <h2>Nothing has happened yet</h2>
          <p>Once the agent starts work on a project, it will show up here.</p>
        </div>
      ) : (
        <ol className="feed-list">
          {items.map((item) => {
            const isOpen = item.id === openId;

            return (
              <li key={item.id} className="feed-item">
                <div className="feed-row">
                  <span className={`feed-dot tone-${item.tone}`} aria-hidden="true" />
                  <div className="feed-body">
                    <div className="feed-top">
                      <strong>{item.headline}</strong>
                      <span className="feed-stamp">{formatActivityStamp(item.stamp)}</span>
                    </div>
                    <p className="feed-detail">{item.detail}</p>
                    <p className="feed-meta">{item.projectName} · {item.domain}</p>
                    <div className="feed-actions">
                      <button type="button" className="ghost-button" onClick={() => onOpenProject(item.projectId)}>
                        Open project
                      </button>
                      {item.technical.length > 0 ? (
                        <button type="button" className="quiet-button" onClick={() => setOpenId(isOpen ? null : item.id)}>
                          {isOpen ? "Hide detail" : "Detail"}
                        </button>
                      ) : null}
                    </div>
                    {isOpen ? (
                      <ul className="feed-technical">
                        {item.technical.map((line, index) => (
                          <li key={index}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}