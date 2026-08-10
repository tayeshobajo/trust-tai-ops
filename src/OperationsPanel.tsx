import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { validateAdvance } from "./operations";
import { workspaceRepository } from "./repository";
import type { Organization, Project, Run, RunState } from "./types";
import { stateCopy } from "./data";

/**
 * OperationsPanel — Phase 3 & 4 interactive controls
 *
 * Run advancement, approval, QA completion, rollback, evidence capture,
 * recommendation writeback. Renders inside the Active Run tab.
 */

type OperationsPanelProps = {
  project: Project;
  run: Run;
  canWrite: boolean;
  onWorkspaceUpdate: (next: Organization) => void;
  setSaveMessage: Dispatch<SetStateAction<string>>;
};

type Panel = "advance" | "approve" | "qa" | "evidence" | "rollback" | "recommend" | "memory" | null;

export function OperationsPanel({
  project,
  run,
  canWrite,
  onWorkspaceUpdate,
  setSaveMessage,
}: OperationsPanelProps) {
  const [open, setOpen] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (panel: Panel) => setOpen((p) => (p === panel ? null : panel));

  const next = getNextLawfulState(run.state);
  const advanceCheck = next ? validateAdvance(run, next) : null;
  const canAdvance = !!next && !!advanceCheck?.ok && canWrite;

  const needsApproval =
    run.approvalRequired &&
    !run.approvals.some((a) => a.type === "high_risk_execution" && a.status === "approved");

  const canRollback =
    ["execution", "qa", "recommendations", "paused", "escalated", "failed"].includes(run.state) &&
    canWrite;

  return (
    <div className="ops-panel">
      <div className="ops-panel-head">
        <p className="eyebrow">Operations</p>
        <h4>Run controls</h4>
      </div>

      <div className="ops-button-row">
        {next && (
          <button
            className={`ops-btn ops-btn-advance ${canAdvance ? "" : "is-blocked"}`}
            onClick={() => toggle("advance")}
            disabled={busy}
          >
            <span>Advance →</span>
            <small>{stateCopy[next]?.label ?? next}</small>
          </button>
        )}

        {needsApproval && (
          <button
            className="ops-btn ops-btn-approve"
            onClick={() => toggle("approve")}
            disabled={busy}
          >
            <span>Approve</span>
            <small>High-risk gate</small>
          </button>
        )}

        <button
          className="ops-btn"
          onClick={() => toggle("qa")}
          disabled={busy}
        >
          <span>QA Checks</span>
          <small>{run.qaReport.results.length} checks</small>
        </button>

        <button
          className="ops-btn"
          onClick={() => toggle("evidence")}
          disabled={busy}
        >
          <span>Add Evidence</span>
          <small>Artifacts & proof</small>
        </button>

        <button
          className="ops-btn"
          onClick={() => toggle("recommend")}
          disabled={busy}
        >
          <span>Recommend</span>
          <small>Write follow-up</small>
        </button>

        <button
          className="ops-btn"
          onClick={() => toggle("memory")}
          disabled={busy}
        >
          <span>Memory Note</span>
          <small>Durable project note</small>
        </button>

        {canRollback && (
          <button
            className="ops-btn ops-btn-rollback"
            onClick={() => toggle("rollback")}
            disabled={busy}
          >
            <span>Rollback</span>
            <small>Reverse course</small>
          </button>
        )}
      </div>

      {/* Advance panel */}
      {open === "advance" && next && (
        <AdvancePanel
          run={run}
          target={next}
          check={advanceCheck}
          canWrite={canWrite}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setOpen(null);
            setSaveMessage(`Run advanced to ${stateCopy[getNextLawfulState(run.state) ?? run.state]?.label ?? "next phase"}.`);
          }}
          projectId={project.id}
        />
      )}

      {/* Approve panel */}
      {open === "approve" && (
        <ApprovePanel
          run={run}
          projectId={project.id}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setOpen(null);
            setSaveMessage("Approval decision recorded.");
          }}
        />
      )}

      {/* QA panel */}
      {open === "qa" && (
        <QaPanel
          run={run}
          projectId={project.id}
          canWrite={canWrite}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setSaveMessage("QA check updated.");
          }}
        />
      )}

      {/* Evidence panel */}
      {open === "evidence" && (
        <EvidencePanel
          run={run}
          projectId={project.id}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setOpen(null);
            setSaveMessage("Evidence captured.");
          }}
        />
      )}

      {/* Recommend panel */}
      {open === "recommend" && (
        <RecommendPanel
          run={run}
          projectId={project.id}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setOpen(null);
            setSaveMessage("Recommendation written.");
          }}
        />
      )}

      {/* Memory note panel */}
      {open === "memory" && (
        <MemoryNotePanel
          projectId={project.id}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setOpen(null);
            setSaveMessage("Memory note saved.");
          }}
        />
      )}

      {/* Rollback panel */}
      {open === "rollback" && (
        <RollbackPanel
          run={run}
          projectId={project.id}
          busy={busy}
          setBusy={setBusy}
          onDone={(next) => {
            onWorkspaceUpdate(next);
            setOpen(null);
            setSaveMessage("Rollback recorded. Run is now in rolled-back state.");
          }}
        />
      )}
    </div>
  );
}

// ─── Advance ────────────────────────────────────────────────────────────────

function AdvancePanel({
  run,
  target,
  check,
  canWrite,
  busy,
  setBusy,
  projectId,
  onDone,
}: {
  run: Run;
  target: RunState;
  check: ReturnType<typeof validateAdvance> | null;
  canWrite: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  projectId: string;
  onDone: (next: Organization) => void;
}) {
  const [error, setError] = useState("");

  const handleAdvance = async () => {
    if (!check?.ok) return;
    setError("");
    setBusy(true);
    try {
      const next = await workspaceRepository.advanceRun(projectId, run.id, target);
      onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Advance failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel">
      <h5>Advance to: <strong>{stateCopy[target]?.label}</strong></h5>
      <p className="ops-tone">{stateCopy[target]?.tone}</p>

      {check && !check.ok ? (
        <div className="ops-guardrail">
          <strong>Guardrail blocked</strong>
          <p>{check.message}</p>
          {check.requiresApproval && (
            <p className="ops-hint">Use the Approve control to record approval first.</p>
          )}
        </div>
      ) : (
        <div className="ops-guardrail ops-guardrail-ok">
          <p>{stateCopy[target]?.guardrail}</p>
        </div>
      )}

      {error && <p className="ops-error">{error}</p>}

      <div className="ops-actions">
        <button
          className="primary-button"
          onClick={handleAdvance}
          disabled={busy || !check?.ok || !canWrite}
        >
          {busy ? "Advancing..." : `Advance to ${stateCopy[target]?.label}`}
        </button>
      </div>
    </div>
  );
}

// ─── Approve ────────────────────────────────────────────────────────────────

function ApprovePanel({
  run,
  projectId,
  busy,
  setBusy,
  onDone,
}: {
  run: Run;
  projectId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (next: Organization) => void;
}) {
  const [type, setType] = useState<"high_risk_execution" | "qa_waiver" | "rollback">("high_risk_execution");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const handleApprove = async () => {
    if (!reason.trim()) { setError("Reason is required."); return; }
    setError("");
    setBusy(true);
    try {
      const next = await workspaceRepository.approveRun(projectId, run.id, type, decision, reason.trim());
      onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel">
      <h5>Record Approval Decision</h5>

      <label className="field">
        <span>Approval type</span>
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="high_risk_execution">High-risk execution</option>
          <option value="qa_waiver">QA waiver</option>
          <option value="rollback">Rollback authorization</option>
        </select>
      </label>

      <div className="ops-decision-row">
        <label className="check">
          <input type="radio" name="decision" value="approved" checked={decision === "approved"}
            onChange={() => setDecision("approved")} />
          <div><strong>Approve</strong></div>
        </label>
        <label className="check">
          <input type="radio" name="decision" value="rejected" checked={decision === "rejected"}
            onChange={() => setDecision("rejected")} />
          <div><strong>Reject</strong></div>
        </label>
      </div>

      <label className="field">
        <span>Reason</span>
        <textarea rows={3} value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="State why this decision was made." />
      </label>

      {error && <p className="ops-error">{error}</p>}

      <div className="ops-actions">
        <button className="primary-button" onClick={handleApprove} disabled={busy || !reason.trim()}>
          {busy ? "Recording..." : "Record Decision"}
        </button>
      </div>
    </div>
  );
}

// ─── QA ─────────────────────────────────────────────────────────────────────

function QaPanel({
  run,
  projectId,
  canWrite,
  busy,
  setBusy,
  onDone,
}: {
  run: Run;
  projectId: string;
  canWrite: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (next: Organization) => void;
}) {
  const [verdictMode, setVerdictMode] = useState(false);
  const [verdict, setVerdict] = useState<"passed" | "failed" | "partial" | "waived">(run.qaReport.verdict);
  const [verdictSummary, setVerdictSummary] = useState(run.qaReport.summary);
  const [error, setError] = useState("");

  const handleResultUpdate = async (resultId: string, result: "passed" | "failed" | "warning" | "skipped", notes: string) => {
    setBusy(true);
    try {
      const next = await workspaceRepository.updateQaResult(projectId, run.id, resultId, result, notes);
      onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "QA update failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleVerdictSet = async () => {
    if (!verdictSummary.trim()) { setError("Summary required."); return; }
    setBusy(true);
    try {
      const next = await workspaceRepository.setQaVerdict(projectId, run.id, verdict, verdictSummary.trim());
      onDone(next);
      setVerdictMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verdict update failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel">
      <div className="ops-sub-head">
        <h5>QA Checks</h5>
        <button className="ghost-button" onClick={() => setVerdictMode(!verdictMode)}>
          {verdictMode ? "← Back to checks" : "Set verdict"}
        </button>
      </div>

      {verdictMode ? (
        <div className="ops-verdict-form">
          <label className="field">
            <span>Overall verdict</span>
            <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="partial">Partial</option>
              <option value="waived">Waived</option>
            </select>
          </label>
          <label className="field">
            <span>Summary</span>
            <textarea rows={3} value={verdictSummary} onChange={(e) => setVerdictSummary(e.target.value)} />
          </label>
          {error && <p className="ops-error">{error}</p>}
          <button className="primary-button" onClick={handleVerdictSet} disabled={busy}>
            {busy ? "Saving..." : "Save verdict"}
          </button>
        </div>
      ) : (
        <div className="ops-qa-list">
          <div className="ops-verdict-chip ops-verdict-chip--{run.qaReport.verdict}">
            Current verdict: <strong>{run.qaReport.verdict}</strong>
          </div>
          {run.qaReport.results.map((result) => (
            <QaResultRow
              key={result.id}
              result={result}
              canWrite={canWrite}
              busy={busy}
              onUpdate={(r, notes) => handleResultUpdate(result.id, r, notes)}
            />
          ))}
          {run.qaReport.results.length === 0 && (
            <p className="muted-copy">No QA checks defined yet for this run.</p>
          )}
          {error && <p className="ops-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

function QaResultRow({
  result,
  canWrite,
  busy,
  onUpdate,
}: {
  result: Run["qaReport"]["results"][0];
  canWrite: boolean;
  busy: boolean;
  onUpdate: (result: "passed" | "failed" | "warning" | "skipped", notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [localResult, setLocalResult] = useState(result.result);
  const [notes, setNotes] = useState(result.notes);

  return (
    <div className="qa-result-row">
      <div className="qa-result-top">
        <strong>{result.name}</strong>
        <span className={`pill pill-${result.result}`}>{result.result}</span>
        {canWrite && (
          <button className="ghost-button" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel" : "Edit"}
          </button>
        )}
      </div>
      {editing ? (
        <div className="qa-result-edit">
          <select value={localResult} onChange={(e) => setLocalResult(e.target.value as typeof localResult)}>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="warning">Warning</option>
            <option value="skipped">Skipped</option>
          </select>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes..." />
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => { onUpdate(localResult, notes); setEditing(false); }}
          >
            Save
          </button>
        </div>
      ) : (
        <p className="muted-copy">{result.notes || "No notes yet."}</p>
      )}
    </div>
  );
}

// ─── Evidence ───────────────────────────────────────────────────────────────

function EvidencePanel({
  run,
  projectId,
  busy,
  setBusy,
  onDone,
}: {
  run: Run;
  projectId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (next: Organization) => void;
}) {
  const [artifactType, setArtifactType] = useState<Run["artifacts"][0]["type"]>("backup_note");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");

  const handleAdd = async () => {
    if (!title.trim() || !summary.trim()) { setError("Title and summary required."); return; }
    setError("");
    setBusy(true);
    try {
      const next = await workspaceRepository.addEvidence(projectId, run.id, artifactType, title.trim(), summary.trim());
      onDone(next);
      setTitle("");
      setSummary("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evidence capture failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel">
      <h5>Capture Evidence</h5>

      <div className="ops-artifact-list">
        {run.artifacts.map((a) => (
          <div key={a.id} className="list-card">
            <div className="list-card-top">
              <strong>{a.title}</strong>
              <span className="pill">{a.type.replace("_", " ")}</span>
            </div>
            <p>{a.summary}</p>
          </div>
        ))}
      </div>

      <label className="field">
        <span>Evidence type</span>
        <select value={artifactType} onChange={(e) => setArtifactType(e.target.value as typeof artifactType)}>
          <option value="backup_note">Backup note</option>
          <option value="scan_result">Scan result</option>
          <option value="diff_summary">Diff summary</option>
          <option value="qa_capture">QA capture</option>
          <option value="report">Report</option>
        </select>
      </label>

      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Backup confirmed by WP Engine dashboard" />
      </label>

      <label className="field">
        <span>Summary</span>
        <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What this evidence proves." />
      </label>

      {error && <p className="ops-error">{error}</p>}

      <div className="ops-actions">
        <button className="primary-button" onClick={handleAdd} disabled={busy || !title.trim() || !summary.trim()}>
          {busy ? "Saving..." : "Capture evidence"}
        </button>
      </div>
    </div>
  );
}

// ─── Recommend ──────────────────────────────────────────────────────────────

function RecommendPanel({
  run,
  projectId,
  busy,
  setBusy,
  onDone,
}: {
  run: Run;
  projectId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (next: Organization) => void;
}) {
  const [category, setCategory] = useState<"security" | "performance" | "stability" | "maintenance" | "process">("process");
  const [priority, setPriority] = useState<"medium" | "high" | "critical">("medium");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");

  const handleAdd = async () => {
    if (!title.trim() || !summary.trim()) { setError("Title and summary required."); return; }
    setError("");
    setBusy(true);
    try {
      const next = await workspaceRepository.addRecommendation(projectId, run.id, category, priority, title.trim(), summary.trim());
      onDone(next);
      setTitle(""); setSummary("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recommendation write failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel">
      <h5>Write Recommendation</h5>

      <div className="field two-up">
        <label className="field">
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
            <option value="security">Security</option>
            <option value="performance">Performance</option>
            <option value="stability">Stability</option>
            <option value="maintenance">Maintenance</option>
            <option value="process">Process</option>
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enable automatic backups before each run" />
      </label>

      <label className="field">
        <span>Summary</span>
        <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What should be done and why." />
      </label>

      {error && <p className="ops-error">{error}</p>}

      <div className="ops-actions">
        <button className="primary-button" onClick={handleAdd} disabled={busy || !title.trim() || !summary.trim()}>
          {busy ? "Saving..." : "Write recommendation"}
        </button>
      </div>
    </div>
  );
}

// ─── Memory Note ─────────────────────────────────────────────────────────────

function MemoryNotePanel({
  projectId,
  busy,
  setBusy,
  onDone,
}: {
  projectId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (next: Organization) => void;
}) {
  const [type, setType] = useState<"stack_note" | "incident_note" | "risk_note" | "qa_rule" | "procedure">("stack_note");
  const [importance, setImportance] = useState<"medium" | "high" | "critical">("high");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  const handleAdd = async () => {
    if (!title.trim() || !content.trim()) { setError("Title and content required."); return; }
    setError("");
    setBusy(true);
    try {
      const next = await workspaceRepository.addMemoryEntry(projectId, { title: title.trim(), type, importance, content: content.trim() });
      onDone(next);
      setTitle(""); setContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memory write failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel">
      <h5>Capture Memory Note</h5>

      <div className="field two-up">
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="stack_note">Stack note</option>
            <option value="incident_note">Incident note</option>
            <option value="risk_note">Risk note</option>
            <option value="qa_rule">QA rule</option>
            <option value="procedure">Procedure</option>
          </select>
        </label>
        <label className="field">
          <span>Importance</span>
          <select value={importance} onChange={(e) => setImportance(e.target.value as typeof importance)}>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PHP 8.2 breaks legacy plugin — do not upgrade without testing" />
      </label>

      <label className="field">
        <span>Content</span>
        <textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="The durable truth this project needs to remember." />
      </label>

      {error && <p className="ops-error">{error}</p>}

      <div className="ops-actions">
        <button className="primary-button" onClick={handleAdd} disabled={busy || !title.trim() || !content.trim()}>
          {busy ? "Saving..." : "Save to project memory"}
        </button>
      </div>
    </div>
  );
}

// ─── Rollback ────────────────────────────────────────────────────────────────

function RollbackPanel({
  run,
  projectId,
  busy,
  setBusy,
  onDone,
}: {
  run: Run;
  projectId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (next: Organization) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");

  const handleRollback = async () => {
    if (!reason.trim() || !confirmed) return;
    setError("");
    setBusy(true);
    try {
      const next = await workspaceRepository.rollbackRun(projectId, run.id, reason.trim());
      onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-sub-panel ops-sub-panel--danger">
      <h5>Execute Rollback</h5>
      <p className="ops-tone">
        This marks the run as rolled back and logs the reversal as a high finding.
        Use only when reverting changes is the right next move.
      </p>

      <label className="field">
        <span>Reason for rollback</span>
        <textarea rows={3} value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Describe exactly what is being reversed and why." />
      </label>

      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <div>
          <strong>I confirm this rollback is intentional</strong>
          <small>This will mark the run as rolled back. A new run should be opened to confirm the result.</small>
        </div>
      </label>

      {error && <p className="ops-error">{error}</p>}

      <div className="ops-actions">
        <button
          className="danger-button"
          onClick={handleRollback}
          disabled={busy || !reason.trim() || !confirmed}
        >
          {busy ? "Rolling back..." : "Execute rollback"}
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNextLawfulState(state: RunState): RunState | null {
  const normal: RunState[] = [
    "intake", "access_check", "backup_gate", "environment_mapping",
    "diagnosis", "plan", "execution", "qa", "recommendations", "complete",
  ];
  const idx = normal.indexOf(state);
  if (idx === -1 || idx >= normal.length - 1) return null;
  return normal[idx + 1];
}
