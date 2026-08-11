/**
 * Inline meeting review.
 *
 * A meeting arrives in the conversation like anything else: the agent says
 * what it understood, then shows the work it wants to do. Nothing here starts
 * a task by itself — every proposal waits for a person to say yes.
 */

import { useState } from "react";
import type { MeetingAnalysisView, ProposedTask } from "./meetings";

const RISK_LABEL: Record<string, string> = {
  safe: "Low risk",
  cautious: "Needs care",
  high_risk: "High risk",
};

type MeetingPlanReviewProps = {
  analysis: MeetingAnalysisView;
  canWrite: boolean;
  busyTaskId: string | null;
  decided: Record<string, "approved" | "rejected">;
  onApprove: (task: ProposedTask) => void;
  onReject: (task: ProposedTask) => void;
};

export function MeetingPlanReview({
  analysis,
  canWrite,
  busyTaskId,
  decided,
  onApprove,
  onReject,
}: MeetingPlanReviewProps) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const pending = analysis.proposedTasks.filter((task) => !decided[task.id] && task.status === "proposed");

  return (
    <section className="meeting-review" aria-label="What I took from the meeting">
      <p className="eyebrow">From {analysis.sourceTitle}</p>
      <p className="meeting-summary">{analysis.summary}</p>

      {analysis.decisions.length > 0 ? (
        <div className="meeting-block">
          <h4>Decisions I heard</h4>
          <ul>
            {analysis.decisions.map((decision, index) => (
              <li key={index}>
                <span>{decision.statement}</span>
                {decision.provenance[0] ? (
                  <q className="meeting-quote">{decision.provenance[0].excerpt}</q>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.constraints.length > 0 ? (
        <div className="meeting-block">
          <h4>Constraints to respect</h4>
          <ul>
            {analysis.constraints.map((constraint, index) => (
              <li key={index}>{constraint.statement}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.openQuestions.length > 0 ? (
        <div className="meeting-block">
          <h4>Still unanswered</h4>
          <ul>
            {analysis.openQuestions.map((item, index) => (
              <li key={index}>
                <span>{item.question}</span>
                {item.whyItMatters ? <em>{item.whyItMatters}</em> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="meeting-block">
        <h4>{pending.length > 0 ? "Work I'd like to take on" : "Proposed work"}</h4>
        {analysis.proposedTasks.length === 0 ? (
          <p className="meeting-empty">Nothing in this meeting needs work from me yet.</p>
        ) : null}

        <ul className="meeting-tasks">
          {analysis.proposedTasks.map((task) => {
            const decision = decided[task.id] ?? (task.status === "approved" || task.status === "rejected" ? task.status : null);
            const open = openTaskId === task.id;
            return (
              <li key={task.id} className={`meeting-task${decision ? ` is-${decision}` : ""}`}>
                <div className="meeting-task-head">
                  <div>
                    <h5>{task.title}</h5>
                    <p className="meeting-task-ask">{task.clientAsk}</p>
                  </div>
                  <span className={`meeting-risk tone-${task.riskLevel}`}>{RISK_LABEL[task.riskLevel] ?? task.riskLevel}</span>
                </div>

                <button className="meeting-toggle" type="button" onClick={() => setOpenTaskId(open ? null : task.id)}>
                  {open ? "Hide detail" : "Why I'm suggesting this"}
                </button>

                {open ? (
                  <div className="meeting-task-detail">
                    {task.provenance.map((entry, index) => (
                      <q key={index} className="meeting-quote">{entry.excerpt}</q>
                    ))}
                    {task.implementationApproach ? <p><strong>Approach.</strong> {task.implementationApproach}</p> : null}
                    {task.verificationExpectation ? <p><strong>How I'd prove it.</strong> {task.verificationExpectation}</p> : null}
                    {task.accessNeeded.length > 0 ? (
                      <p><strong>Access needed.</strong> {task.accessNeeded.join(", ")}</p>
                    ) : null}
                    {task.needsInvestigation ? <p>I'd investigate before committing to a fix.</p> : null}
                    {task.requiresExecutionApproval ? (
                      <p className="meeting-gate">I'll still ask you again before I change anything.</p>
                    ) : null}
                  </div>
                ) : null}

                {decision ? (
                  <p className="meeting-decided">
                    {decision === "approved" ? "Started as a task." : "Left alone."}
                  </p>
                ) : (
                  <div className="decision-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!canWrite || busyTaskId !== null}
                      onClick={() => onApprove(task)}
                    >
                      {busyTaskId === task.id ? "Starting…" : "Start this"}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={!canWrite || busyTaskId !== null}
                      onClick={() => onReject(task)}
                    >
                      Not now
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}