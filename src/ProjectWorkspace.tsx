import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessType, Organization, Project, Run } from "./types";
import { buildThread, draftFromBrief } from "./conversation";
import type { DecisionKind, ThreadMessage } from "./conversation";
import { formatActivityStamp, getProjectInitials, signalForRun } from "./home";
import { HUMAN_PHASES } from "./home";
import { workspaceRepository } from "./repository";
import { validateAdvance } from "./operations";
import { autoAdvanceTarget, projectHasUsableAccess, simulateQa, workingNarration } from "./agent";
import { ProjectAccessPanel } from "./ProjectAccessPanel";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { ProjectActivityPanel } from "./ProjectActivityPanel";
import { deriveMemoryFromRun } from "./memory";

type ProjectWorkspaceProps = {
  project: Project;
  canWrite: boolean;
  startInNewTask?: boolean;
  initialSurface?: "conversation" | "access";
  onBackToProjects: () => void;
  onWorkspaceUpdate: (next: Organization) => void;
};

type LocalMessage = { id: string; role: "user" | "agent"; body: string[] };

const agentStateLabel = (run: Run | null) => {
  if (!run) return "Ready";
  const signal = signalForRun(run);
  if (signal.agentState === "needs_you") return "Waiting for you";
  switch (run.state) {
    case "execution":
      return "Applying fix";
    case "qa":
      return "Running final checks";
    case "recommendations":
      return "Wrapping up";
    case "intake":
    case "access_check":
      return "Getting started";
    case "complete":
      return "Ready";
    default:
      return "Investigating";
  }
};

export function ProjectWorkspace({
  project,
  canWrite,
  startInNewTask = false,
  initialSurface = "conversation",
  onBackToProjects,
  onWorkspaceUpdate,
}: ProjectWorkspaceProps) {
  const runs = project.runs;
  const [activeRunId, setActiveRunId] = useState<string | null>(
    startInNewTask ? null : runs.find((run) => run.state !== "complete")?.id ?? runs[0]?.id ?? null,
  );
  const [composerValue, setComposerValue] = useState("");
  const [localMessages, setLocalMessages] = useState<Record<string, LocalMessage[]>>({});
  const [busy, setBusy] = useState(false);
  const [mobilePane, setMobilePane] = useState<"tasks" | "chat" | "context">("chat");
  const [surface, setSurface] = useState<"conversation" | "access" | "memory" | "activity">(initialSurface);
  const [accessFocus, setAccessFocus] = useState<AccessType[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const attemptedRef = useRef<Set<string>>(new Set());
  const memoryRef = useRef<Set<string>>(new Set());

  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  const signal = activeRun ? signalForRun(activeRun) : null;

  const thread = useMemo<ThreadMessage[]>(
    () => (activeRun ? buildThread(project, activeRun) : []),
    [project, activeRun],
  );

  const extras = activeRun ? localMessages[activeRun.id] ?? [] : localMessages.__new ?? [];

  useEffect(() => {
    composerRef.current?.focus();
  }, [activeRunId]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length, extras.length]);

  const pushLocal = (runId: string, message: LocalMessage) => {
    setLocalMessages((current) => ({ ...current, [runId]: [...(current[runId] ?? []), message] }));
  };

  const apply = async (work: () => Promise<Organization>, agentReply?: string) => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      const next = await work();
      onWorkspaceUpdate(next);
      if (agentReply && activeRun) {
        pushLocal(activeRun.id, { id: `local-${Date.now()}`, role: "agent", body: [agentReply] });
      }
    } finally {
      setBusy(false);
    }
  };

  const advanceTo = async (run: Run, target: Run["state"]) => {
    if (!validateAdvance(run, target).ok) return;
    await apply(() => workspaceRepository.advanceRun(project.id, run.id, target));
  };

  const openAccessSurface = (types: AccessType[] = []) => {
    setAccessFocus(types);
    setSurface("access");
  };

  // When a task closes out, persist only the durable facts the run data supports.
  useEffect(() => {
    if (!canWrite) return;
    const completed = runs.filter((run) => run.state === "complete");
    for (const run of completed) {
      if (memoryRef.current.has(run.id)) continue;
      const derived = deriveMemoryFromRun(project, run);
      if (derived.length === 0) {
        memoryRef.current.add(run.id);
        continue;
      }
      memoryRef.current.add(run.id);
      void (async () => {
        try {
          let next: Organization | null = null;
          for (const entry of derived) {
            next = await workspaceRepository.addMemoryEntry(project.id, entry);
          }
          if (next) onWorkspaceUpdate(next);
        } catch {
          // Memory must never block or corrupt the run lifecycle.
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, runs, canWrite]);

  // The agent moves itself through every lawful step that needs no human judgment.
  useEffect(() => {
    if (!canWrite || busy || !activeRun) return;

    const run = activeRun;
    const key = `${run.id}:${run.state}:${run.qaReport.verdict}`;
    if (attemptedRef.current.has(key)) return;

    if (run.state === "qa") {
      const simulation = simulateQa(run);
      if (!simulation) return;
      const timer = window.setTimeout(() => {
        void (async () => {
          if (attemptedRef.current.has(key)) return;
          attemptedRef.current.add(key);
          setBusy(true);
          try {
            for (const update of simulation.updates) {
              await workspaceRepository.updateQaResult(project.id, run.id, update.id, update.result, update.notes);
            }
            let next = await workspaceRepository.setQaVerdict(project.id, run.id, simulation.verdict, simulation.summary);
            if (simulation.verdict !== "failed") {
              next = await workspaceRepository.advanceRun(project.id, run.id, "recommendations");
            }
            onWorkspaceUpdate(next);
          } finally {
            setBusy(false);
          }
        })();
      }, 900);
      return () => window.clearTimeout(timer);
    }

    const target = autoAdvanceTarget(project, run);
    if (!target) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        if (attemptedRef.current.has(key)) return;
        attemptedRef.current.add(key);
        const narration = workingNarration(target);
        if (narration) {
          pushLocal(run.id, { id: `auto-${run.id}-${target}`, role: "agent", body: [narration] });
        }
        setBusy(true);
        try {
          onWorkspaceUpdate(await workspaceRepository.advanceRun(project.id, run.id, target));
        } finally {
          setBusy(false);
        }
      })();
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeRun, canWrite, busy]);

  const startNewTask = () => {
    setActiveRunId(null);
    setComposerValue("");
    setMobilePane("chat");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const sendMessage = async () => {
    const value = composerValue.trim();
    if (!value) return;

    if (!activeRun) {
      setBusy(true);
      try {
        const next = await workspaceRepository.createRun(project.id, draftFromBrief(project, value));
        onWorkspaceUpdate(next);
        const created = next.projects.find((item) => item.id === project.id)?.runs[0];
        setActiveRunId(created?.id ?? null);
        setComposerValue("");
      } finally {
        setBusy(false);
      }
      return;
    }

    pushLocal(activeRun.id, { id: `local-${Date.now()}`, role: "user", body: [value] });
    pushLocal(activeRun.id, {
      id: `local-${Date.now()}-agent`,
      role: "agent",
      body: ["Noted. I've added that to the task context and I'll factor it into what I do next."],
    });
    setComposerValue("");
  };

  const renderDecision = (run: Run, kind: DecisionKind) => {
    if (!kind) return null;

    if (kind === "access") {
      const hasAccess = projectHasUsableAccess(project);
      return (
        <div className="decision-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => openAccessSurface(["wordpress_admin", "sftp", "ssh"])}
          >
            {hasAccess ? "Review access" : "Add access"}
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={!canWrite || busy}
            onClick={() => void advanceTo(run, "environment_mapping")}
          >
            Continue read-only for now
          </button>
        </div>
      );
    }

    if (kind === "backup") {
      return (
        <div className="decision-actions">
          <button
            className="primary-button"
            type="button"
            disabled={!canWrite || busy}
            onClick={async () => {
              await apply(() => workspaceRepository.confirmBackup(project.id, run.id, "Backup confirmed by the site owner in conversation."));
              await apply(() => workspaceRepository.advanceRun(project.id, run.id, "environment_mapping"));
            }}
          >
            Confirm backup
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={() =>
              pushLocal(run.id, {
                id: `local-${Date.now()}`,
                role: "agent",
                body: [
                  "No problem. Most hosts have a one-click backup in their control panel, and plugins like UpdraftPlus can also create one. Tell me who hosts the site and I'll point you to the exact place.",
                ],
              })
            }
          >
            Help me create one
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={() =>
              pushLocal(run.id, {
                id: `local-${Date.now()}`,
                role: "agent",
                body: ["Understood. I'll keep this read-only and carry on investigating without changing anything."],
              })
            }
          >
            Investigate only
          </button>
        </div>
      );
    }

    if (kind === "approval") {
      return (
        <div className="decision-actions">
          <button
            className="primary-button"
            type="button"
            disabled={!canWrite || busy}
            onClick={async () => {
              await apply(() => workspaceRepository.approveRun(project.id, run.id, "high_risk_execution", "approved", "Owner approved the recommended fix in conversation."));
              await apply(() => workspaceRepository.advanceRun(project.id, run.id, "execution"));
            }}
          >
            Proceed with fix
          </button>
          <button className="ghost-button" type="button" onClick={() => composerRef.current?.focus()}>
            Ask a question
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={!canWrite || busy}
            onClick={() =>
              void apply(
                () => workspaceRepository.approveRun(project.id, run.id, "high_risk_execution", "rejected", "Owner asked for a different approach."),
                "Understood. I'll look for a safer or different route and come back with another option.",
              )
            }
          >
            Request another approach
          </button>
        </div>
      );
    }

    return null;
  };

  if (surface === "access") {
    return (
      <ProjectAccessPanel
        project={project}
        canWrite={canWrite}
        focusTypes={accessFocus}
        onBackToConversation={() => setSurface("conversation")}
        onWorkspaceUpdate={onWorkspaceUpdate}
      />
    );
  }

  if (surface === "memory") {
    return (
      <ProjectMemoryPanel
        project={project}
        canWrite={canWrite}
        onBackToConversation={() => setSurface("conversation")}
        onWorkspaceUpdate={onWorkspaceUpdate}
      />
    );
  }

  if (surface === "activity") {
    return <ProjectActivityPanel project={project} onBackToConversation={() => setSurface("conversation")} />;
  }

  return (
    <div className={`pw-shell pane-${mobilePane}`}>
      <aside className="pw-tasks">
        <div className="pw-tasks-head">
          <button className="create-back" type="button" onClick={onBackToProjects}>
            Projects
          </button>
          <div className="pw-identity">
            <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
            <div>
              <strong>{project.name}</strong>
              <small>{project.primaryDomain}</small>
            </div>
          </div>
          <button className="primary-button pw-new-task" type="button" onClick={startNewTask}>
            New Task
          </button>
        </div>

        <div className="pw-task-list">
          {runs.length === 0 ? <p className="pw-empty-note">No tasks yet. Describe what you need and I'll start one.</p> : null}
          {runs.map((run) => {
            const rowSignal = signalForRun(run);
            return (
              <button
                key={run.id}
                type="button"
                className={`pw-task-row ${run.id === activeRunId ? "is-active" : ""}`}
                onClick={() => {
                  setActiveRunId(run.id);
                  setMobilePane("chat");
                }}
              >
                <div className="pw-task-row-top">
                  <strong>{run.title}</strong>
                  <span className="pw-stamp">{formatActivityStamp(run.updatedAt)}</span>
                </div>
                <p>{rowSignal.status}</p>
                {rowSignal.agentState === "needs_you" ? <span className="pw-attention" aria-label="Needs you" /> : null}
              </button>
            );
          })}
        </div>

        <nav className="pw-secondary" aria-label="Project sections">
          <button type="button" onClick={() => setSurface("memory")}>
            Memory
          </button>
          <button type="button" onClick={() => openAccessSurface([])}>
            Access
          </button>
          <button type="button" onClick={() => setSurface("activity")}>
            Activity
          </button>
        </nav>
      </aside>

      <main className="pw-chat">
        <header className="pw-chat-head">
          <button className="pw-pane-toggle" type="button" onClick={() => setMobilePane("tasks")}>
            Tasks
          </button>
          <div className="pw-chat-title">
            <strong>Engineering Agent</strong>
            <small>{project.name} · {project.primaryDomain}</small>
          </div>
          <span className="agent-state">{agentStateLabel(activeRun)}</span>
          <button className="pw-pane-toggle" type="button" onClick={() => setMobilePane("context")}>
            Task
          </button>
        </header>

        <div className="pw-thread">
          {!activeRun ? (
            <div className="conversation-intro">
              <h2>New task</h2>
              <p>Tell me what you would like me to investigate, fix, improve, or build. I&apos;ll guide the rest.</p>
            </div>
          ) : null}

          {thread.map((message) => (
            <article key={message.id} className={`pw-msg pw-msg-${message.role}`}>
              {message.role === "agent" ? <span className="pw-msg-who">Engineering Agent</span> : null}
              {message.body.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
              {message.card ? (
                <div className="pw-card">
                  <h4>{message.card.title}</h4>
                  <ul>
                    {message.card.items.map((item, index) => (
                      <li key={index} className={`tone-${item.tone ?? "neutral"}`}>
                        <strong>{item.label}</strong>
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {activeRun && message.decision ? renderDecision(activeRun, message.decision) : null}
            </article>
          ))}

          {extras.map((message) => (
            <article key={message.id} className={`pw-msg pw-msg-${message.role}`}>
              {message.role === "agent" ? <span className="pw-msg-who">Engineering Agent</span> : null}
              {message.body.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </article>
          ))}
          <div ref={threadEndRef} />
        </div>

        <div className="pw-composer">
          <textarea
            ref={composerRef}
            className="composer-input"
            rows={2}
            value={composerValue}
            placeholder="Describe the issue, task, or outcome you want help with..."
            aria-label="Message the Engineering Agent"
            onChange={(event) => setComposerValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          <div className="composer-row">
            <button className="composer-attach" type="button" aria-label="Attach a file">＋</button>
            <button className="primary-button" type="button" disabled={!composerValue.trim() || busy} onClick={() => void sendMessage()}>
              Send
            </button>
          </div>
        </div>
      </main>

      <aside className="pw-context">
        <button className="pw-pane-back" type="button" onClick={() => setMobilePane("chat")}>
          Back to conversation
        </button>
        {activeRun && signal ? (
          <>
            <p className="eyebrow">Current task</p>
            <h3>{activeRun.title}</h3>

            <ol className="pw-phases">
              {HUMAN_PHASES.map((phase) => {
                const currentIndex = signal.phase ? HUMAN_PHASES.indexOf(signal.phase) : -1;
                const index = HUMAN_PHASES.indexOf(phase);
                const state = index < currentIndex ? "done" : index === currentIndex ? "now" : "next";
                return (
                  <li key={phase} className={`pw-phase is-${state}`}>
                    {phase}
                  </li>
                );
              })}
            </ol>

            <section className="pw-context-block">
              <p className="eyebrow">Happening now</p>
              <p>{signal.detail}</p>
            </section>

            <section className="pw-context-block">
              <p className="eyebrow">What happens next</p>
              <p>{activeRun.nextAction}</p>
            </section>

            <section className="pw-context-block">
              <p className="eyebrow">Agent needs</p>
              <p>{signal.needsYou ?? "Nothing needed from you right now."}</p>
            </section>
          </>
        ) : (
          <>
            <p className="eyebrow">Current task</p>
            <h3>Nothing running</h3>
            <p className="pw-empty-note">Send your first message and I&apos;ll open a task for it.</p>
          </>
        )}
      </aside>
    </div>
  );
}
