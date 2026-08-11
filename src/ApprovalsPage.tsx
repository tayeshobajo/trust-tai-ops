import type { Organization } from "./types";
import { buildPendingDecisions } from "./globalFeed";
import { formatActivityStamp } from "./home";

type Props = {
  workspace: Organization;
  onOpenProject: (projectId: string) => void;
};

export function ApprovalsPage({ workspace, onOpenProject }: Props) {
  const decisions = buildPendingDecisions(workspace);

  return (
    <div className="global-surface">
      <header className="global-surface-head">
        <p className="eyebrow">Needs you</p>
        <h1>Approvals</h1>
        <p className="global-surface-lede">
          Every decision the agent is waiting on, across all projects. Nothing here is a report — each row is a real
          choice only you can make.
        </p>
      </header>

      {decisions.length === 0 ? (
        <div className="global-empty">
          <h2>Nothing needs your approval.</h2>
          <p>The agent will bring decisions here when your judgment is required.</p>
        </div>
      ) : (
        <ul className="approval-list">
          {decisions.map((decision) => (
            <li key={decision.id} className="approval-row">
              <div className="approval-main">
                <div className="approval-top">
                  <strong>{decision.projectName}</strong>
                  <span className={`status-chip tone-attention`}>{decision.label}</span>
                  <span className="feed-stamp">{formatActivityStamp(decision.stamp)}</span>
                </div>
                <p className="approval-decision">{decision.decision}</p>
                <p className="approval-why">{decision.why}</p>
                <p className="feed-meta">{decision.domain}</p>
              </div>
              <button type="button" className="primary-button" onClick={() => onOpenProject(decision.projectId)}>
                Open conversation
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}