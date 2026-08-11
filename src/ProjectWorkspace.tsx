import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessType, NewProjectMessage, Organization, Project, ProjectMessage, Run } from "./types";
import { buildThread, draftFromBrief } from "./conversation";
import type { DecisionKind, ThreadCard, ThreadMessage } from "./conversation";
import {
  dayLabel,
  findHitsOutsideRun,
  highlightSegments,
  matchesQuery,
  contentSignature,
  dedupeKeyForThreadMessage,
  kindForThreadMessage,
  shouldPersistThreadMessage,
  sortMessages,
  timeLabel,
} from "./messages";
import { formatActivityStamp, getProjectInitials, signalForRun } from "./home";
import { HUMAN_PHASES } from "./home";
import { workspaceRepository } from "./repository";
import { validateAdvance } from "./operations";
import { projectHasUsableAccess } from "./agent";
import { agentStepIdentity, executeAgentStep } from "./agentExecutor";
import { ProjectAccessPanel } from "./ProjectAccessPanel";
import type { AccessEvent } from "./ProjectAccessPanel";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { ProjectActivityPanel } from "./ProjectActivityPanel";
import { deriveMemoryFromRun } from "./memory";

// Long conversations render in a trailing window and grow on request, so a
// task with hundreds of messages opens as fast as a fresh one.
const PAGE_SIZE = 40;

/** Marks the searched phrase inside a line so results are scannable. */
function Highlight({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="pw-hit-mark">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

type ProjectWorkspaceProps = {
  project: Project;
  canWrite: boolean;
  startInNewTask?: boolean;
  initialSurface?: "conversation" | "access";
  onBackToProjects: () => void;
  onWorkspaceUpdate: (next: Organization) => void;
};

type ViewItem = {
  key: string;
  role: "user" | "agent" | "system";
  body: string[];
  createdAt: string | null;
  card?: ThreadCard;
  decision?: DecisionKind;
};

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

const agentStateTone = (run: Run | null) => {
  if (!run) return "";
  const signal = signalForRun(run);
  if (signal.agentState === "needs_you") return "agent-state-needs_you";
  if (run.state === "complete") return "agent-state-complete";
  return "agent-state-working";
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
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mobilePane, setMobilePane] = useState<"tasks" | "chat" | "context">("chat");
  const [surface, setSurface] = useState<"conversation" | "tasks" | "access" | "memory" | "activity">(initialSurface);
  const [accessFocus, setAccessFocus] = useState<AccessType[]>([]);
  const [query, setQuery] = useState("");
  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const attemptedRef = useRef<Set<string>>(new Set());
  const memoryRef = useRef<Set<string>>(new Set());
  const emitRef = useRef<Set<string>>(new Set());
  // Synchronous claim on decision actions, taken before any await, so a fast
  // double click cannot start the same domain action twice while React is
  // still committing the busy state.
  const decisionRef = useRef<Set<string>>(new Set());
  // How far the reader expanded earlier messages, per task, so returning to a
  // task reopens the thread at the same window size.
  const windowSizeRef = useRef<Map<string, number>>(new Map());

  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  const signal = activeRun ? signalForRun(activeRun) : null;

  const thread = useMemo<ThreadMessage[]>(
    () => (activeRun ? buildThread(project, activeRun) : []),
    [project, activeRun],
  );

  // Stored conversation for this project. Loaded once per project.
  useEffect(() => {
    let alive = true;
    setMessagesLoaded(false);
    void (async () => {
      try {
        const stored = await workspaceRepository.listProjectMessages(project.id);
        if (alive) setMessages(sortMessages(stored));
      } catch {
        // A conversation that cannot be read must never block the workspace.
        if (alive) setMessages([]);
      } finally {
        if (alive) setMessagesLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.id]);

  const runMessages = useMemo(
    () =>
      sortMessages(
        messages.filter((message) => (activeRun ? message.runId === activeRun.id : message.runId === null)),
      ),
    [messages, activeRun],
  );

  const persistedKeys = useMemo(
    () => new Set(runMessages.map((message) => message.dedupeKey).filter((key): key is string => Boolean(key))),
    [runMessages],
  );

  // Second guard: the same sentence is never shown or stored twice, even if the
  // reconstruction produces it again under a different id later in the task.
  const persistedContent = useMemo(
    () => new Set(runMessages.map((message) => contentSignature(message.role, message.body))),
    [runMessages],
  );

  // A task is "native" when its opening brief was written to the conversation
  // record. Older tasks keep their deterministic reconstruction and are never
  // backfilled with history that was never actually stored.
  const isNativeRun = Boolean(
    activeRun && runMessages.some((message) => message.sourceKey === `${activeRun.id}-brief`),
  );

  const visible = useMemo<ViewItem[]>(() => {
    if (!activeRun) {
      return runMessages.map((message) => ({
        key: message.id,
        role: message.role,
        body: message.body,
        createdAt: message.createdAt,
      }));
    }

    if (!isNativeRun) {
      // Fallback: reconstructed thread first, then anything genuinely stored since.
      return [
        ...thread.map((message) => ({
          key: message.id,
          role: message.role,
          body: message.body,
          createdAt: null,
          card: message.card,
          decision: message.decision,
        })),
        ...runMessages.map((message) => ({
          key: message.id,
          role: message.role,
          body: message.body,
          createdAt: message.createdAt,
        })),
      ];
    }

    const derivedBySource = new Map(thread.map((message) => [message.id, message]));
    const items: ViewItem[] = runMessages.map((message) => {
      const source = message.sourceKey ? derivedBySource.get(message.sourceKey) : undefined;
      return {
        key: message.id,
        role: message.role,
        body: message.body,
        createdAt: message.createdAt,
        card: source?.card,
        decision: source?.decision,
      };
    });

    for (const message of thread) {
      if (!shouldPersistThreadMessage(message)) continue;
      if (persistedKeys.has(dedupeKeyForThreadMessage(message))) continue;
      if (persistedContent.has(contentSignature(message.role, message.body))) continue;
      items.push({
        key: `pending-${message.id}`,
        role: message.role,
        body: message.body,
        createdAt: null,
        card: message.card,
        decision: message.decision,
      });
    }

    return items;
  }, [activeRun, isNativeRun, persistedContent, persistedKeys, runMessages, thread]);

  const searching = query.trim().length > 0;

  const filtered = useMemo(
    () => (searching ? visible.filter((item) => matchesQuery(item.body, query)) : visible),
    [visible, query, searching],
  );

  const hidden = Math.max(0, filtered.length - windowSize);
  const windowed = useMemo(() => (hidden > 0 ? filtered.slice(hidden) : filtered), [filtered, hidden]);

  const otherHits = useMemo(
    () => (searching ? findHitsOutsideRun(messages, activeRun?.id ?? null, query) : []),
    [messages, activeRun, query, searching],
  );

  const windowKey = activeRunId ?? "project";

  // A search always starts from the end; a task reopens where it was left.
  useEffect(() => {
    setWindowSize(query.trim() ? PAGE_SIZE : windowSizeRef.current.get(windowKey) ?? PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, query]);

  useEffect(() => {
    setQuery("");
  }, [activeRunId]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [activeRunId]);

  useEffect(() => {
    if (!messagesLoaded || searching) return;
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messagesLoaded, visible.length, surface, searching]);

  // Single write path for every message the user actually sees.
  const emit = async (input: NewProjectMessage): Promise<ProjectMessage | null> => {
    const key = input.dedupeKey ?? null;
    if (key && emitRef.current.has(key)) return null;
    if (key) emitRef.current.add(key);

    try {
      const saved = await workspaceRepository.addProjectMessage(project.id, input);
      setMessages((current) => (current.some((item) => item.id === saved.id) ? current : sortMessages([...current, saved])));
      setPersistError(null);
      return saved;
    } catch {
      if (key) emitRef.current.delete(key);
      setPersistError("I couldn't save that to the conversation history. The work itself is unaffected — you can try again.");
      return null;
    }
  };

  // Bridge: once a task has a real conversation record, keep it complete.
  useEffect(() => {
    if (!canWrite || !messagesLoaded || !activeRun || !isNativeRun) return;

    const pending = thread.filter(
      (message) =>
        shouldPersistThreadMessage(message) &&
        !persistedKeys.has(dedupeKeyForThreadMessage(message)) &&
        !persistedContent.has(contentSignature(message.role, message.body)),
    );

    if (pending.length === 0) return;

    void (async () => {
      const written = new Set<string>();
      for (const message of pending) {
        const signature = contentSignature(message.role, message.body);
        if (written.has(signature)) continue;
        written.add(signature);
        await emit({
          runId: activeRun.id,
          role: "agent",
          kind: kindForThreadMessage(message),
          body: message.body,
          dedupeKey: dedupeKeyForThreadMessage(message),
          sourceKey: message.id,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun, canWrite, isNativeRun, messagesLoaded, persistedContent, persistedKeys, thread]);

  const say = async (
    runId: string | null,
    body: string[],
    kind: NewProjectMessage["kind"] = "message",
    dedupeKey?: string,
  ) => {
    await emit({ runId, role: "agent", kind, body, dedupeKey: dedupeKey ?? `agent-${runId ?? "project"}-${Date.now()}` });
  };

  const apply = async (work: () => Promise<Organization>, agentReply?: string, replyKey?: string) => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      const next = await work();
      onWorkspaceUpdate(next);
      if (agentReply && activeRun) {
        await say(activeRun.id, [agentReply], "message", replyKey);
      }
    } finally {
      setBusy(false);
    }
  };

  // Conversation history for access changes. Built only from the predefined
  // connection label and the action — never from any submitted form value.
  const recordAccessEvent = ({ type, label, action }: AccessEvent) => {
    const runId = activeRun?.id ?? null;
    const subject = /access$/i.test(label.trim()) ? label : `${label} access`;
    void emit({
      runId,
      role: "user",
      kind: "decision_response",
      body: [`${subject} ${action}.`],
      dedupeKey: `access-${runId ?? "project"}-${type}-${action}-${Date.now()}`,
    });
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

  // The agent moves itself through every lawful step that needs no human
  // judgment. The executor owns what it says and how that is persisted.
  useEffect(() => {
    if (!canWrite || busy || !activeRun) return;

    const run = activeRun;
    const identity = agentStepIdentity(project, run);
    if (!identity || attemptedRef.current.has(identity)) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        if (attemptedRef.current.has(identity)) return;
        attemptedRef.current.add(identity);
        setBusy(true);
        try {
          await executeAgentStep({
            project,
            run,
            emit,
            onWorkspaceUpdate,
            recentMessages: messages.filter((message) => message.runId === run.id),
            memory: project.memoryEntries,
          });
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
        // The brief becomes the first real message of the new task.
        const saved = await emit({
          runId: created?.id ?? null,
          role: "user",
          kind: "message",
          body: [value],
          dedupeKey: created ? `${created.id}-brief` : `project-brief-${Date.now()}`,
          sourceKey: created ? `${created.id}-brief` : null,
        });
        setActiveRunId(created?.id ?? null);
        if (saved) setComposerValue("");
      } catch {
        setPersistError("I couldn't start that task. Your message is still here — try again.");
      } finally {
        setBusy(false);
      }
      return;
    }

    const stamp = Date.now();
    const saved = await emit({
      runId: activeRun.id,
      role: "user",
      kind: "message",
      body: [value],
      dedupeKey: `user-${activeRun.id}-${stamp}`,
    });

    if (!saved) return;

    setComposerValue("");
    await emit({
      runId: activeRun.id,
      role: "agent",
      kind: "message",
      body: ["Noted. I've added that to the task context and I'll factor it into what I do next."],
      dedupeKey: `ack-${activeRun.id}-${stamp}`,
    });
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
            onClick={async () => {
              await advanceTo(run, "environment_mapping");
              await emit({
                runId: run.id,
                role: "user",
                kind: "decision_response",
                body: ["Continue read-only for now."],
                dedupeKey: `decision-readonly-${run.id}`,
              });
            }}
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
              // History only. The backup gate itself remains the authority.
              await emit({
                runId: run.id,
                role: "user",
                kind: "decision_response",
                body: ["Backup confirmed."],
                dedupeKey: `decision-backup-${run.id}`,
              });
            }}
          >
            Confirm backup
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={async () => {
              await emit({
                runId: run.id,
                role: "user",
                kind: "message",
                body: ["Help me create a backup first."],
                dedupeKey: `decision-backup-help-${run.id}`,
              });
              await emit({
                runId: run.id,
                role: "agent",
                kind: "message",
                body: [
                  "No problem. Most hosts have a one-click backup in their control panel, and plugins like UpdraftPlus can also create one. Tell me who hosts the site and I'll point you to the exact place.",
                ],
                dedupeKey: `decision-backup-help-reply-${run.id}`,
              });
            }}
          >
            Help me create one
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={busy}
            onClick={async () => {
              await emit({
                runId: run.id,
                role: "user",
                kind: "decision_response",
                body: ["Investigate only. Do not make changes yet."],
                dedupeKey: `decision-investigate-only-${run.id}`,
              });
              await emit({
                runId: run.id,
                role: "agent",
                kind: "message",
                body: ["Understood. I'll keep this read-only and carry on investigating without changing anything."],
                dedupeKey: `decision-investigate-only-reply-${run.id}`,
              });
            }}
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
              await emit({
                runId: run.id,
                role: "user",
                kind: "decision_response",
                body: ["Approved. Proceed with the recommended fix."],
                dedupeKey: `decision-approval-${run.id}`,
              });
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
            onClick={async () => {
              const claim = `decision-approval-rejected-${run.id}`;
              if (decisionRef.current.has(claim)) return;
              decisionRef.current.add(claim);
              try {
                await apply(
                  () => workspaceRepository.approveRun(project.id, run.id, "high_risk_execution", "rejected", "Owner asked for a different approach."),
                  "Understood. I'll look for a safer or different route and come back with another option.",
                  `decision-approval-rejected-reply-${run.id}`,
                );
              } catch (error) {
                // A failed domain call must stay retryable.
                decisionRef.current.delete(claim);
                throw error;
              }
              await emit({
                runId: run.id,
                role: "user",
                kind: "decision_response",
                body: ["Use the safer approach instead."],
                dedupeKey: claim,
              });
            }}
          >
            Request another approach
          </button>
        </div>
      );
    }

    return null;
  };

  // The visible destination is derived from real state, never hardcoded. On a
  // narrow viewport the task list is a pane of the conversation surface, so it
  // reads as Tasks while it is the pane on screen.
  const activeNav =
    surface === "conversation" ? (mobilePane === "tasks" ? "tasks" : "conversation") : surface;

  const goToSurface = (next: typeof surface) => {
    if (next === "conversation") {
      setSurface("conversation");
      setMobilePane("chat");
      return;
    }
    if (next === "tasks") {
      setSurface("conversation");
      setMobilePane("tasks");
      return;
    }
    setSurface(next);
    setMobilePane("chat");
  };

  const navItems: Array<[typeof surface, string]> = [
    ["conversation", "Conversation"],
    ["tasks", "Tasks"],
    ["access", "Access"],
    ["memory", "Memory"],
    ["activity", "Activity"],
  ];

  const renderProjectNav = (variant: "rail" | "bar") => (
    <nav className={variant === "bar" ? "pw-secondary pw-secondary-bar" : "pw-secondary"} aria-label="Project sections">
      {navItems.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={activeNav === key ? "is-active" : ""}
          aria-current={activeNav === key ? "page" : undefined}
          onClick={() => (key === "access" ? openAccessSurface([]) : goToSurface(key))}
        >
          {label}
        </button>
      ))}
    </nav>
  );

  const secondarySurface =
    surface === "access" ? (
      <ProjectAccessPanel
        project={project}
        canWrite={canWrite}
        focusTypes={accessFocus}
        embedded
        onWorkspaceUpdate={onWorkspaceUpdate}
        onAccessEvent={recordAccessEvent}
      />
    ) : surface === "memory" ? (
      <ProjectMemoryPanel project={project} canWrite={canWrite} embedded onWorkspaceUpdate={onWorkspaceUpdate} />
    ) : surface === "activity" ? (
      <ProjectActivityPanel project={project} embedded />
    ) : null;

  return (
    <div className={`pw-shell pane-${mobilePane} ${secondarySurface ? "is-surface" : ""}`}>
      <aside className="pw-tasks">
        <div className="pw-tasks-head">
          <button className="create-back is-back" type="button" onClick={onBackToProjects}>
            <span aria-hidden="true">&#8592;</span>
            All projects
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

        {renderProjectNav("rail")}
      </aside>

      {secondarySurface ? (
        <main className="pw-surface">{secondarySurface}</main>
      ) : (
      <>
      <main className="pw-chat">
        <header className="pw-chat-head">
          <button className="pw-pane-toggle" type="button" onClick={() => setMobilePane("tasks")}>
            Tasks
          </button>
          <div className="pw-chat-title">
            <strong>Engineering Agent</strong>
            <small>{project.name} · {project.primaryDomain}</small>
          </div>
          <span className={`agent-state ${agentStateTone(activeRun)}`}>{agentStateLabel(activeRun)}</span>
          <button className="pw-pane-toggle" type="button" onClick={() => setMobilePane("context")}>
            Task
          </button>
        </header>

        <div className="pw-search">
          <input
            type="search"
            className="pw-search-input"
            value={query}
            placeholder="Search this conversation"
            aria-label="Search this conversation"
            onChange={(event) => setQuery(event.target.value)}
          />
          {searching ? (
            <div className="pw-search-meta">
              <span>
                {filtered.length === 0
                  ? "No messages match"
                  : `${filtered.length} ${filtered.length === 1 ? "message" : "messages"} in this task`}
              </span>
              <button type="button" onClick={() => setQuery("")}>Clear</button>
            </div>
          ) : null}
        </div>

        {searching && otherHits.length > 0 ? (
          <div className="pw-search-other">
            <p className="eyebrow">Also found in other tasks</p>
            {otherHits.map((hit, index) => {
              const hitRun = hit.runId ? runs.find((run) => run.id === hit.runId) ?? null : null;
              return (
                <button
                  key={`${hit.runId ?? "project"}-${index}`}
                  type="button"
                  className="pw-search-hit"
                  onClick={() => {
                    setActiveRunId(hit.runId);
                    setMobilePane("chat");
                  }}
                >
                  <strong>{hitRun ? hitRun.title : "Project conversation"}</strong>
                  <span>
                    {hit.role === "user" ? "You" : "Engineering Agent"} ·{" "}
                    <Highlight text={hit.excerpt} query={query} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="pw-thread">
          {hidden > 0 ? (
            <button className="pw-load-earlier" type="button" onClick={() =>
                setWindowSize((size) => {
                  const next = size + PAGE_SIZE;
                  // Remember the expansion for this task, but never for a search view.
                  if (!searching) windowSizeRef.current.set(windowKey, next);
                  return next;
                })
              }>
              Show earlier messages ({hidden})
            </button>
          ) : null}

          {!activeRun ? (
            <div className="conversation-intro">
              <h2>New task</h2>
              <p>Tell me what you would like me to investigate, fix, improve, or build. I&apos;ll guide the rest.</p>
            </div>
          ) : null}

          {windowed.map((message, position) => {
            const previous = position > 0 ? windowed[position - 1] : null;
            const divider =
              message.createdAt && (!previous?.createdAt || dayLabel(previous.createdAt) !== dayLabel(message.createdAt))
                ? dayLabel(message.createdAt)
                : null;

            return (
              <div key={message.key} className="pw-msg-wrap">
                {divider ? <p className="pw-day-divider"><span>{divider}</span></p> : null}
                <article className={`pw-msg pw-msg-${message.role}`}>
                  {message.role === "agent" ? (
                    <span className="pw-msg-who">
                      Engineering Agent
                      {message.createdAt ? <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time> : null}
                    </span>
                  ) : null}
                  {message.body.map((paragraph, index) => (
                    <p key={index}>{searching ? <Highlight text={paragraph} query={query} /> : paragraph}</p>
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
                  {message.role === "user" && message.createdAt ? (
                    <time className="pw-msg-time" dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
                  ) : null}
                </article>
              </div>
            );
          })}

          {persistError ? (
            <p className="pw-persist-error" role="status">
              {persistError}
              <button type="button" onClick={() => setPersistError(null)}>Dismiss</button>
            </p>
          ) : null}
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
      </>
      )}

      <div className="pw-mobile-top">
        <button className="create-back is-back" type="button" onClick={onBackToProjects}>
          <span aria-hidden="true">&#8592;</span>
          All projects
        </button>
        <span className="pw-mobile-title">{project.name}</span>
      </div>

      {renderProjectNav("bar")}
    </div>
  );
}
