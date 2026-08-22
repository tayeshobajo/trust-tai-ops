import { useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "./supabase";
import type { Project } from "./types";

/**
 * Captain Outcome History — the "memory" surface of the intelligence layer.
 *
 * Every job Captain completes lands here as a structured record: what type of
 * job it was, what it targeted, whether it passed, and what follow-up (if any)
 * is scheduled. This panel is read-only for humans; rows are written by
 * Captain (via the captain-write-back edge function) and by the plan daemon.
 */

export type CaptainOutcome = {
  id: string;
  project_id: string;
  request_id: string | null;
  job_type: string;
  target: string;
  verdict: "pass" | "fail" | "partial";
  summary: string;
  evidence: string | null;
  outcome_data: Record<string, unknown>;
  next_action_type: string | null;
  next_action_due_at: string | null;
  captain_session_ref: string | null;
  completed_by: string;
  created_at: string;
};

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const verdictTone = (verdict: CaptainOutcome["verdict"]) =>
  verdict === "pass" ? "good" : verdict === "fail" ? "bad" : "warn";

const verdictGlyph = (verdict: CaptainOutcome["verdict"]) =>
  verdict === "pass" ? "✅" : verdict === "fail" ? "❌" : "⚠️";

export function ProjectOutcomesPanel({ project }: { project: Project; embedded?: boolean }) {
  const [outcomes, setOutcomes] = useState<CaptainOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabaseClient();
        const { data, error: queryError } = await supabase
          .from("captain_outcomes")
          .select("*")
          .eq("project_id", project.id)
          .order("created_at", { ascending: false })
          .limit(100);
        if (cancelled) return;
        if (queryError) throw new Error(queryError.message);
        setOutcomes((data ?? []) as CaptainOutcome[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load outcomes");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const upcoming = useMemo(
    () =>
      outcomes
        .filter((o) => o.next_action_due_at && new Date(o.next_action_due_at) > new Date())
        .sort((a, b) => (a.next_action_due_at! < b.next_action_due_at! ? -1 : 1)),
    [outcomes],
  );

  if (loading) {
    return (
      <div className="access-surface is-embedded">
        <p className="mem-empty">Loading Captain outcome history…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="access-surface is-embedded">
        <header className="access-head">
          <div>
            <p className="eyebrow">Captain Outcomes</p>
            <h1>Something went wrong</h1>
          </div>
        </header>
        <p className="mem-empty tone-bad">{error}</p>
      </div>
    );
  }

  return (
    <div className="access-surface is-embedded">
      <header className="access-head">
        <div>
          <p className="eyebrow">Captain Outcome History</p>
          <h1>{project.name}</h1>
          <small>{project.primaryDomain}</small>
        </div>
      </header>
      <p className="access-intro">
        Every job Captain has completed here — with structured results and scheduled follow-ups.
      </p>

      {upcoming.length > 0 ? (
        <>
          <p className="eyebrow pw-task-group">Scheduled follow-ups · {upcoming.length}</p>
          <ul className="pw-queue">
            {upcoming.map((o) => (
              <li key={`next-${o.id}`}>
                <strong>{o.next_action_type}</strong> on {o.target}
                <small> due {fmtDateTime(o.next_action_due_at)}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="eyebrow pw-task-group">All outcomes · {outcomes.length}</p>
      {outcomes.length === 0 ? (
        <p className="mem-empty">
          No outcomes yet. When Captain completes a job on this project, it will be recorded here.
        </p>
      ) : (
        <ul className="pw-task-surface">
          {outcomes.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="pw-outcome-row"
                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
              >
                <span className="pw-outcome-glyph">{verdictGlyph(o.verdict)}</span>
                <span className="pw-outcome-main">
                  <strong>{o.job_type}</strong>
                  <small>
                    {o.target} · {fmtDate(o.created_at)}
                  </small>
                </span>
                <span className={`pw-outcome-verdict tone-${verdictTone(o.verdict)}`}>{o.verdict}</span>
              </button>
              {expanded === o.id ? (
                <div className="pw-outcome-detail">
                  <p>{o.summary}</p>
                  {o.evidence ? (
                    <details>
                      <summary>Evidence</summary>
                      <pre>{o.evidence}</pre>
                    </details>
                  ) : null}
                  {Object.keys(o.outcome_data).length > 0 ? (
                    <details>
                      <summary>Structured data</summary>
                      <pre>{JSON.stringify(o.outcome_data, null, 2)}</pre>
                    </details>
                  ) : null}
                  {o.next_action_due_at ? (
                    <p className="tone-warn">
                      <strong>Next:</strong> {o.next_action_type} due {fmtDateTime(o.next_action_due_at)}
                    </p>
                  ) : null}
                  <small className="pw-outcome-meta">
                    completed by {o.completed_by}
                    {o.captain_session_ref ? ` · session ${o.captain_session_ref.slice(0, 18)}…` : ""}
                  </small>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
