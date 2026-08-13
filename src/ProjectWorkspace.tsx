import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessType, NewProjectMessage, Organization, Project, ProjectMessage, Run, RunDraft } from "./types";
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
import { ProjectPipelineSummary } from "./ProjectPipelineSummary";
import { validateAdvance } from "./operations";
import { projectHasUsableAccess } from "./agent";
import { composeReply } from "./reply";
import { agentStepIdentity, executeAgentStep } from "./agentExecutor";
import { ProjectAccessPanel } from "./ProjectAccessPanel";
import type { AccessEvent } from "./ProjectAccessPanel";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { ProjectActivityPanel } from "./ProjectActivityPanel";
import { deriveMemoryFromRun } from "./memory";
import { MeetingPlanReview } from "./MeetingPlanReview";
import { decideProposedTask, ingestAndAnalyzeMeeting, meetingIntelligenceAvailable } from "./meetings";
import type { MeetingAnalysisView, ProposedTask } from "./meetings";
import {
  ACCEPT_ATTRIBUTE,
  attachEvidenceToMessage,
  dequeueEvidenceFile,
  enqueueEvidenceFiles,
  evidenceIntakeAvailable,
  evidenceReplyLines,
  evidenceViewUrl,
  filesFromDataTransfer,
  formatBytes,
  imageFilesFromClipboard,
  listProjectEvidence,
  releaseQueuedFile,
  uploadEvidence,
} from "./evidence";
import type { QueuedFile, QueuedState } from "./evidence";
import type { ProjectEvidence } from "./types";
import { containsSecretMaterial } from "./agent-core/secretGuard";
import { credentialIntakeAvailable, submitCredentialText } from "./agent-core/credentialIntake";
import {
  continuityAvailable,
  indexConversationAnchors,
  provenanceLine,
  referenceIntent,
  resolveReference,
} from "./continuity";

// Long conversations render in a trailing window and grow on request, so a
// task with hundreds of messages opens as fast as a fresh one.
const PAGE_SIZE = 40;

// One small read-only task holds every access-confirmation conversation.
const ACCESS_RUN_TITLE = "Confirm project access";

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

/** Inline marks rather than emoji: they inherit colour, size and weight. */
const PaperclipIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.4-7.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
  </svg>
);

const WarningIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M12 4.5 21 19.5H3z" strokeLinejoin="round" />
    <path d="M12 10v4.2M12 17h.01" strokeLinecap="round" />
  </svg>
);

/** A calm "agent is thinking" cue that replaces the silent disabled send state. */
const TypingIndicator = () => (
  <article className="pw-msg pw-msg-agent pw-typing" aria-busy="true" aria-live="polite">
    <span className="pw-msg-who">Engineering Agent</span>
    <div className="pw-typing-dots">
      <span />
      <span />
      <span />
    </div>
  </article>
);

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
  // The agent's own background step must never lock the person's composer.
  const [agentBusy, setAgentBusy] = useState(false);
  // Keep the typing indicator visible for a short beat after the agent starts
  // working so the cue doesn't flicker on fast replies.
  const [typingUntil, setTypingUntil] = useState(0);
  const [mobilePane, setMobilePane] = useState<"tasks" | "chat" | "context">("chat");
  const [surface, setSurface] = useState<"conversation" | "tasks" | "access" | "memory" | "activity">(initialSurface);
  const [accessFocus, setAccessFocus] = useState<AccessType[]>([]);
  const [query, setQuery] = useState("");
  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  // Meeting intake lives inside the conversation, not in a separate CRM.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptTitle, setTranscriptTitle] = useState("");
  const [transcriptText, setTranscriptText] = useState("");
  // Evidence a person attached to this conversation, with the agent's reading
  // of it. Files are never held in the message body: they are separate,
  // server-owned records pinned to the message they arrived with.
  const [evidence, setEvidence] = useState<ProjectEvidence[]>([]);
  const [pendingFiles, setPendingFiles] = useState<QueuedFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [meetingAnalysis, setMeetingAnalysis] = useState<MeetingAnalysisView | null>(null);
  const [taskDecisions, setTaskDecisions] = useState<Record<string, "approved" | "rejected">>({});
  const [taskBusyId, setTaskBusyId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // The composer grows with what is being written, up to a calm ceiling, then
  // scrolls. It never leaves an oversized empty box behind after sending.
  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    node.style.height = `${Math.min(node.scrollHeight, max)}px`;
    node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
  }, [composerValue]);

  useEffect(() => {
    if (busy) {
      setTypingUntil(Date.now() + 1200);
    }
  }, [busy]);
  useEffect(() => {
    if (agentBusy) {
      setTypingUntil(Date.now() + 1200);
    }
  }, [agentBusy]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const [runPlan, setRunPlan] = useState<RunPlan | null>(null);

  const thread = useMemo<ThreadMessage[]>(
    () => (activeRun ? buildThread(project, activeRun) : []),
    [project, activeRun],
  );

  // The agent's living plan for the current task. Re-read whenever the
  // conversation moves, because that is when the agent revises it.
  useEffect(() => {
    if (!activeRunId) {
      setRunPlan(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const stored = await workspaceRepository.loadRunPlan(project.id, activeRunId);
        if (alive) setRunPlan(stored);
      } catch {
        if (alive) setRunPlan(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.id, activeRunId, messages.length]);

  // Attachments for this project, loaded once alongside the conversation.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stored = await listProjectEvidence(project.id);
        if (alive) setEvidence(stored);
      } catch {
        if (alive) setEvidence([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.id]);

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
      // A labelled choice becomes referenceable the moment it is said, so
      // "option B" still means something months later.
      if (saved.role === "agent" && continuityAvailable()) void indexConversationAnchors(project.id, saved.id);
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
    if (!canWrite || busy || agentBusy || !activeRun) return;

    const run = activeRun;
    const identity = agentStepIdentity(project, run);
    if (!identity || attemptedRef.current.has(identity)) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        if (attemptedRef.current.has(identity)) return;
        attemptedRef.current.add(identity);
        setAgentBusy(true);
        try {
          // A stalled server step must not strand the conversation.
          await Promise.race([
            executeAgentStep({
              project,
              run,
              emit,
              onWorkspaceUpdate,
              recentMessages: messages.filter((message) => message.runId === run.id),
              memory: project.memoryEntries,
            }),
            new Promise((resolve) => window.setTimeout(resolve, 45000)),
          ]);
        } finally {
          setAgentBusy(false);
        }
      })();
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeRun, canWrite, busy, agentBusy]);

  const startNewTask = () => {
    setActiveRunId(null);
    setComposerValue("");
    setMobilePane("chat");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  /**
   * A meeting enters the project as conversation. The agent says it received
   * the transcript, then says what it understood. Nothing is started here.
   */
  const submitTranscript = async () => {
    const text = transcriptText.trim();
    if (text.length < 40) {
      setMeetingError("I need the meeting text itself before I can read it.");
      return;
    }

    setMeetingBusy(true);
    setMeetingError(null);
    const title = transcriptTitle.trim() || "Client meeting";
    const stamp = Date.now();

    try {
      await emit({
        runId: activeRun?.id ?? null,
        role: "user",
        kind: "message",
        body: [`Shared a transcript from ${title}.`],
        dedupeKey: `transcript-${project.id}-${stamp}`,
      });

      const result = await ingestAndAnalyzeMeeting({ projectId: project.id, text, title });
      if (!result.ok) {
        setMeetingError(result.summary);
        return;
      }

      setTranscriptOpen(false);
      setTranscriptText("");
      setTranscriptTitle("");
      setMeetingAnalysis(result.analysis);
      setTaskDecisions({});

      const redactionNote =
        result.redactedCount > 0
          ? ` I removed ${result.redactedCount} credential-looking value${result.redactedCount === 1 ? "" : "s"} before storing it.`
          : "";

      await emit({
        runId: activeRun?.id ?? null,
        role: "agent",
        kind: "message",
        body: [
          `${result.analysis.summary}${redactionNote}`,
          result.analysis.proposedTasks.length > 0
            ? "Here's the work I'd suggest. Tell me which of it to pick up."
            : "Nothing in there needs work from me yet — I've noted the context.",
        ],
        dedupeKey: `meeting-summary-${result.analysis.analysisId}`,
      });
    } catch {
      setMeetingError("I couldn't take that transcript just now.");
    } finally {
      setMeetingBusy(false);
    }
  };

  /**
   * Approval is the moment a proposal becomes real work. The browser only asks:
   * the server creates the run, links the proposal and answers with the run it
   * ended up with, so a second click resolves to the same task rather than a
   * second one.
   */
  const approveProposedTask = async (task: ProposedTask) => {
    const claim = `proposal:${task.id}`;
    if (!canWrite || taskBusyId || decisionRef.current.has(claim)) return;
    decisionRef.current.add(claim);
    setTaskBusyId(task.id);
    try {
      const decision = await decideProposedTask(project.id, task.id, "approved");
      if (!decision.ok) {
        setMeetingError(decision.summary);
        return;
      }

      // The run exists server-side now; the local workspace catches up from it.
      const next = await workspaceRepository.loadWorkspace();
      onWorkspaceUpdate(next);
      setTaskDecisions((current) => ({ ...current, [task.id]: "approved" }));

      await emit({
        runId: decision.runId,
        role: "user",
        kind: "decision_response",
        body: [`Approved from the meeting: ${task.title}.`],
        dedupeKey: `proposal-approved-${task.id}`,
      });
      if (decision.runId) setActiveRunId(decision.runId);
    } catch {
      setMeetingError("I couldn't start that task. Nothing was changed.");
    } finally {
      decisionRef.current.delete(claim);
      setTaskBusyId(null);
    }
  };

  const rejectProposedTask = async (task: ProposedTask) => {
    const claim = `proposal:${task.id}`;
    if (!canWrite || taskBusyId || decisionRef.current.has(claim)) return;
    decisionRef.current.add(claim);
    setTaskBusyId(task.id);
    try {
      const decision = await decideProposedTask(project.id, task.id, "rejected");
      if (!decision.ok) {
        setMeetingError(decision.summary);
        return;
      }
      setTaskDecisions((current) => ({ ...current, [task.id]: "rejected" }));
      await emit({
        runId: activeRun?.id ?? null,
        role: "user",
        kind: "decision_response",
        body: [`Left for now: ${task.title}.`],
        dedupeKey: `proposal-rejected-${task.id}`,
      });
    } finally {
      decisionRef.current.delete(claim);
      setTaskBusyId(null);
    }
  };

  /**
   * Secure chat intake.
   *
   * The raw text exists only in this call's request body. It is never written
   * to state, storage, history, memory or a model prompt. Only the sanitized
   * server result becomes a conversation message.
   */
  const handleCredentialPaste = async (raw: string) => {
    if (!canWrite || busy) return;

    if (!credentialIntakeAvailable()) {
      setPersistError(
        "I can't reach the secure credential store from here, so I didn't accept those details. Please add them from Access & Connections.",
      );
      return;
    }

    // Synchronous claim, taken before any await, so a double submit cannot
    // run the same intake twice.
    const intakeKey = `intake-${project.id}-${Date.now()}`;
    if (decisionRef.current.has(intakeKey)) return;
    decisionRef.current.add(intakeKey);
    setBusy(true);

    try {
      const result = await submitCredentialText({ projectId: project.id, text: raw, intakeKey });

      if (!result.ok) {
        // Nothing raw is persisted on any failure path.
        if (result.code === "domain_mismatch") {
          setComposerValue("");
          await emit({
            runId: activeRun?.id ?? null,
            role: "agent",
            kind: "message",
            body: result.message.length
              ? result.message
              : ["These credentials appear to belong to another site. I didn't attach them to this project."],
            dedupeKey: `${intakeKey}-mismatch`,
          });
          return;
        }
        setPersistError(result.summary);
        return;
      }

      // The raw text is done with. Clear the composer before anything renders.
      setComposerValue("");

      // One small read-only run holds the access conversation. An existing one
      // is reused rather than duplicated.
      let runId = activeRun?.id ?? null;
      const existingAccessRun = runs.find(
        (run) => run.title === ACCESS_RUN_TITLE && run.state !== "complete",
      );
      if (existingAccessRun) {
        runId = existingAccessRun.id;
      } else if (!runId) {
        const environment =
          project.environments.find((item) => item.type === "production") ?? project.environments[0];
        const draft: RunDraft = {
          title: ACCESS_RUN_TITLE,
          taskType: "qa_only",
          taskSummary: "Confirm the access shared for this project and verify whatever can be verified.",
          urgency: "normal",
          environmentId: environment?.id ?? "",
          accessReady: true,
          backupConfirmed: false,
        };
        const next = await workspaceRepository.createRun(project.id, draft);
        onWorkspaceUpdate(next);
        runId = next.projects.find((item) => item.id === project.id)?.runs[0]?.id ?? null;
      }
      if (runId) setActiveRunId(runId);

      await emit({
        runId,
        role: "user",
        kind: "message",
        body: result.message,
        dedupeKey: `${intakeKey}-shared`,
      });
      await emit({
        runId,
        role: "agent",
        kind: "message",
        body: result.reply,
        dedupeKey: `${intakeKey}-reply`,
      });

      // Access cards follow server truth, never a client claim.
      onWorkspaceUpdate(await workspaceRepository.loadWorkspace());
    } catch {
      setPersistError("I couldn't complete that securely, so nothing was stored. Please try again.");
    } finally {
      decisionRef.current.delete(intakeKey);
      setBusy(false);
    }
  };

  // --- Evidence -------------------------------------------------------------

  const evidenceForMessage = (messageId: string) =>
    evidence.filter((item) => item.messageId === messageId);

  const queueFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setPendingFiles((current) => {
      const { queue, rejected } = enqueueEvidenceFiles(current, incoming);
      setAttachError(rejected.length > 0 ? [...new Set(rejected)].join(" ") : null);
      return queue;
    });
  };

  // Local previews are object URLs: they must be released, or the tab keeps
  // every screenshot the person ever queued alive in memory.
  const pendingRef = useRef<QueuedFile[]>([]);
  pendingRef.current = pendingFiles;
  useEffect(() => () => {
    for (const entry of pendingRef.current) releaseQueuedFile(entry);
  }, []);

  const removeQueuedFile = (key: string) => {
    setPendingFiles((current) => dequeueEvidenceFile(current, key));
  };

  const markQueued = (key: string, state: QueuedState, reason?: string) => {
    setPendingFiles((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, state, reason: reason ?? null } : entry)),
    );
  };

  const openEvidence = async (item: ProjectEvidence) => {
    const url = await evidenceViewUrl(project.id, item.id);
    if (!url) {
      setAttachError("That file isn't reachable right now.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  /**
   * Files are uploaded, read and reported in one pass. The agent only ever
   * says what the server actually returned: an unreadable file is stated as
   * unread rather than described.
   */
  const sendAttachments = async (runId: string | null, messageId: string | null, files: QueuedFile[]) => {
    setUploading(true);
    try {
      const result = await uploadEvidence({
        projectId: project.id,
        runId,
        // Bound at registration; `attach` below is only a compatibility net.
        messageId,
        files,
        onProgress: markQueued,
      });

      if (messageId && result.uploaded.length > 0) {
        await attachEvidenceToMessage({
          projectId: project.id,
          messageId,
          evidenceIds: result.uploaded.map((item) => item.evidenceId),
        });
      }

      // What succeeded leaves the composer; what failed stays, with its reason,
      // so it can be retried rather than vanishing.
      const failedKeys = new Set(
        result.rejected.map((item) => item.clientKey).filter((key): key is string => Boolean(key)),
      );
      setPendingFiles((current) => {
        const keep = current.filter((entry) => failedKeys.has(entry.key));
        for (const entry of current) if (!failedKeys.has(entry.key)) releaseQueuedFile(entry);
        return keep;
      });

      setEvidence(await listProjectEvidence(project.id));

      const lines = [
        ...evidenceReplyLines(result.uploaded),
        ...result.rejected.map((item) => item.summary),
      ];
      if (lines.length > 0) {
        await emit({
          runId,
          role: "agent",
          kind: "message",
          body: lines,
          dedupeKey: `evidence-${messageId ?? runId ?? project.id}-${result.uploaded.map((item) => item.evidenceId).join("-") || "none"}`,
        });
      }
    } catch {
      setAttachError("I couldn't finish reading those files. Nothing was lost — try again.");
    } finally {
      setUploading(false);
    }
  };

  /**
   * A backward reference is resolved server-side before it is treated as an
   * instruction. Returns true when this path owns the turn.
   */
  const handleBackwardReference = async (value: string): Promise<boolean> => {
    setBusy(true);
    try {
      const stamp = Date.now();
      const saved = await emit({
        runId: activeRun?.id ?? null,
        role: "user",
        kind: "message",
        body: [value],
        dedupeKey: `user-${activeRun?.id ?? "project"}-${stamp}`,
      });
      if (!saved) return true;
      setComposerValue("");

      const outcome = await resolveReference(project.id, saved.id);

      // No history layer available, or nothing to resolve: let the normal turn
      // continue rather than stalling a person behind an outage.
      if (outcome.status === "unavailable" || outcome.status === "not_needed") {
        await emit({
          runId: activeRun?.id ?? null,
          role: "agent",
          kind: "message",
          body: composeReply(project, activeRun ?? null, value),
          dedupeKey: `ack-${activeRun?.id ?? "project"}-${stamp}`,
        });
        return true;
      }

      if (outcome.status === "ambiguous" || outcome.status === "not_found") {
        await emit({
          runId: activeRun?.id ?? null,
          role: "agent",
          kind: "decision_request",
          body: (outcome.question ?? "Which earlier piece of work do you mean?").split("\n"),
          dedupeKey: `recall-question-${saved.id}`,
        });
        return true;
      }

      const line = provenanceLine(outcome.references);
      const body = [line ?? "I've found what you're referring to.", "I'll carry on from there."];

      if (!activeRun) {
        const brief = outcome.references[0]?.summary ?? value;
        const next = await workspaceRepository.createRun(project.id, draftFromBrief(project, brief));
        onWorkspaceUpdate(next);
        const created = next.projects.find((item) => item.id === project.id)?.runs[0];
        setActiveRunId(created?.id ?? null);
        await emit({
          runId: created?.id ?? null,
          role: "agent",
          kind: "message",
          body,
          dedupeKey: `recall-${saved.id}`,
        });
        return true;
      }

      await emit({ runId: activeRun.id, role: "agent", kind: "message", body, dedupeKey: `recall-${saved.id}` });
      return true;
    } catch {
      setPersistError("I couldn't check what that referred back to. Try again, or tell me in your own words.");
      return true;
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    const value = composerValue.trim();
    const attachments = pendingFiles;
    if (!value && attachments.length === 0) return;

    // Credential-shaped text never becomes a stored message. It goes straight
    // to the authorized server intake, which parses, authorizes and seals it,
    // and returns a sanitized replacement for the conversation.
    if (value && containsSecretMaterial(value)) {
      await handleCredentialPaste(value);
      return;
    }

    // A message that points backwards ("option B", "same as yesterday") is not
    // a new instruction. It is resolved against stored history first, and if it
    // cannot be resolved the agent asks rather than assumes.
    if (value && attachments.length === 0 && continuityAvailable() && referenceIntent(value).needsRecall) {
      const handled = await handleBackwardReference(value);
      if (handled) return;
    }

    // Filenames are never persisted from the browser: the client's name for a
    // file is unsanitized, and the attachment records are the source of truth.
    const attachmentNote =
      attachments.length > 0
        ? `Shared ${attachments.length} evidence file${attachments.length === 1 ? "" : "s"}.`
        : "";
    const bodyLines = [value, attachmentNote].filter((line) => line.length > 0);

    if (!activeRun) {
      setBusy(true);
      let createdId: string | null = null;
      let savedId: string | null = null;
      try {
        const brief = value || `Review the ${attachments.length === 1 ? "file" : "files"} I've attached.`;
        const next = await workspaceRepository.createRun(project.id, draftFromBrief(project, brief));
        onWorkspaceUpdate(next);
        const created = next.projects.find((item) => item.id === project.id)?.runs[0];
        createdId = created?.id ?? null;
        // The brief becomes the first real message of the new task.
        const saved = await emit({
          runId: createdId,
          role: "user",
          kind: "message",
          body: bodyLines.length > 0 ? bodyLines : [brief],
          dedupeKey: created ? `${created.id}-brief` : `project-brief-${Date.now()}`,
          sourceKey: created ? `${created.id}-brief` : null,
        });
        setActiveRunId(createdId);
        if (saved) {
          savedId = saved.id;
          setComposerValue("");
        }
      } catch {
        setPersistError("I couldn't start that task. Your message is still here — try again.");
      } finally {
        setBusy(false);
      }
      if (savedId && attachments.length > 0) await sendAttachments(createdId, savedId, attachments);
      return;
    }

    setBusy(true);
    const stamp = Date.now();
    try {
      const saved = await emit({
        runId: activeRun.id,
        role: "user",
        kind: "message",
        body: bodyLines,
        dedupeKey: `user-${activeRun.id}-${stamp}`,
      });

      if (!saved) return;

      setComposerValue("");

      if (attachments.length > 0) {
        await sendAttachments(activeRun.id, saved.id, attachments);
        return;
      }

      await emit({
        runId: activeRun.id,
        role: "agent",
        kind: "message",
        body: composeReply(project, activeRun, value),
        dedupeKey: `ack-${activeRun.id}-${stamp}`,
      });
    } finally {
      setBusy(false);
    }
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
    surface === "tasks" ? (
      <div className="access-surface is-embedded">
        <header className="access-head">
          <span className="preview-avatar" aria-hidden="true">{getProjectInitials(project)}</span>
          <div>
            <p className="eyebrow">Work on this project</p>
            <h1>{project.name}</h1>
            <small>{project.primaryDomain}</small>
          </div>
        </header>
        <p className="access-intro">
          Every task the agent has worked on here. Open one to pick the conversation back up.
        </p>
        {runs.length === 0 ? (
          <p className="mem-empty">No tasks yet. Start a conversation and the agent will open one.</p>
        ) : (
          <ul className="pw-task-surface">
            {runs.map((run) => {
              const rowSignal = signalForRun(run);
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    className={`pw-task-row ${run.id === activeRunId ? "is-active" : ""}`}
                    onClick={() => {
                      setActiveRunId(run.id);
                      goToSurface("conversation");
                    }}
                  >
                    <div className="pw-task-row-top">
                      <strong>{run.title}</strong>
                      <span className="pw-stamp">{formatActivityStamp(run.updatedAt)}</span>
                    </div>
                    <p>{rowSignal.status}</p>
                    {rowSignal.agentState === "needs_you" ? <span className="pw-attention" aria-label="Needs you" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    ) : surface === "access" ? (
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
                  {evidenceForMessage(message.key).length > 0 ? (
                    <ul className="pw-evidence-list">
                      {evidenceForMessage(message.key).map((item) => (
                        <li key={item.id} className={`pw-evidence pw-evidence-${item.status}`}>
                          <button type="button" className="pw-evidence-open" onClick={() => void openEvidence(item)}>
                            <span className="pw-evidence-name">{item.filename}</span>
                            <span className="pw-evidence-meta">
                              {item.kind} · {formatBytes(item.sizeBytes)}
                            </span>
                          </button>
                          {item.analysis ? <p className="pw-evidence-read">{item.analysis.summary}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {activeRun && message.decision ? renderDecision(activeRun, message.decision) : null}
                  {message.role === "user" && message.createdAt ? (
                    <time className="pw-msg-time" dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
                  ) : null}
                </article>
              </div>
            );
          })}

          {(busy || agentBusy || Date.now() < typingUntil) && !uploading ? <TypingIndicator /> : null}

          {persistError ? (
            <p className="pw-persist-error" role="status">
              {persistError}
              <button type="button" onClick={() => setPersistError(null)}>Dismiss</button>
            </p>
          ) : null}

          {meetingAnalysis ? (
            <MeetingPlanReview
              analysis={meetingAnalysis}
              canWrite={canWrite}
              busyTaskId={taskBusyId}
              decided={taskDecisions}
              onApprove={(task) => void approveProposedTask(task)}
              onReject={(task) => void rejectProposedTask(task)}
            />
          ) : null}
          <div ref={threadEndRef} />
        </div>

        <div
          className={dropActive ? "pw-composer is-drop-active" : "pw-composer"}
          onDragOver={(event) => {
            if (!evidenceIntakeAvailable()) return;
            if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDropActive(false);
          }}
          onDrop={(event) => {
            if (!evidenceIntakeAvailable()) return;
            event.preventDefault();
            setDropActive(false);
            queueFiles(filesFromDataTransfer(event.dataTransfer));
          }}
        >
          {dropActive ? (
            <p className="pw-drop-hint" role="status">
              Drop files here and I'll read what I can.
            </p>
          ) : null}
          {transcriptOpen ? (
            <div className="transcript-intake">
              <label className="transcript-field">
                <span>Meeting</span>
                <input
                  type="text"
                  value={transcriptTitle}
                  placeholder="Weekly client call"
                  onChange={(event) => setTranscriptTitle(event.target.value)}
                />
              </label>
              <textarea
                className="composer-input"
                rows={6}
                value={transcriptText}
                placeholder="Paste the meeting transcript here. I'll strip anything that looks like a credential before storing it."
                aria-label="Meeting transcript"
                onChange={(event) => setTranscriptText(event.target.value)}
              />
              <input
                type="file"
                accept=".txt,.md,.vtt,.srt,text/plain"
                aria-label="Upload a transcript file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setTranscriptText(await file.text());
                  if (!transcriptTitle.trim()) setTranscriptTitle(file.name.replace(/\.[^.]+$/, ""));
                }}
              />
              {meetingError ? <p className="pw-persist-error" role="status">{meetingError}</p> : null}
              <div className="composer-row">
                <button className="ghost-button" type="button" onClick={() => setTranscriptOpen(false)}>
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={meetingBusy || transcriptText.trim().length < 40}
                  onClick={() => void submitTranscript()}
                >
                  {meetingBusy ? "Reading the meeting…" : "Share with the agent"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="composer-shell">
          <textarea
            ref={composerRef}
            className="composer-input"
            rows={1}
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
            onPaste={(event) => {
              // Only intercept when the clipboard actually carries an image;
              // ordinary text paste must behave exactly as it always did.
              if (!evidenceIntakeAvailable()) return;
              const images = imageFilesFromClipboard(event.clipboardData);
              if (images.length === 0) return;
              event.preventDefault();
              queueFiles(images);
            }}
          />
          {pendingFiles.length > 0 ? (
            <ul className="pw-pending-files">
              {pendingFiles.map((entry) => (
                <li key={entry.key} data-state={entry.state}>
                  {entry.previewUrl ? (
                    <img className="pw-pending-thumb" src={entry.previewUrl} alt="" aria-hidden="true" />
                  ) : (
                    <span className="pw-pending-thumb pw-pending-thumb-glyph" aria-hidden="true">
                      <PaperclipIcon />
                    </span>
                  )}
                  <span className="pw-pending-body">
                    <span className="pw-evidence-name" title={entry.file.name}>
                      {entry.file.name}
                    </span>
                    <span className="pw-evidence-meta">
                      {entry.state === "failed"
                        ? entry.reason ?? "Didn't go through — try again."
                        : entry.state === "uploading"
                        ? "Uploading…"
                        : entry.state === "reading"
                        ? "Reading…"
                        : formatBytes(entry.file.size)}
                    </span>
                  </span>
                  <button
                    className="pw-pending-remove"
                    type="button"
                    aria-label={`Remove ${entry.file.name}`}
                    onClick={() => removeQueuedFile(entry.key)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {attachError ? (
            <p className="pw-persist-error" role="status">
              <WarningIcon />
              {attachError}
              <button type="button" onClick={() => setAttachError(null)}>Dismiss</button>
            </p>
          ) : null}

          <div className="composer-row">
            {evidenceIntakeAvailable() ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  accept={ACCEPT_ATTRIBUTE}
                  aria-label="Attach files for the agent to read"
                  onChange={(event) => {
                    queueFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <button
                  className="composer-attach"
                  type="button"
                  aria-label="Attach a screenshot, recording, log or export"
                  title="Attach a screenshot, recording, log or export"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                </button>
              </>
            ) : null}
            {meetingIntelligenceAvailable() ? (
              <button
                className="composer-attach"
                type="button"
                aria-label="Share a meeting transcript"
                title="Share a meeting transcript"
                onClick={() => setTranscriptOpen((open) => !open)}
              >
                ＋
              </button>
            ) : null}
            <button
              className="primary-button"
              type="button"
              disabled={(!composerValue.trim() && pendingFiles.length === 0) || busy || uploading}
              onClick={() => void sendMessage()}
            >
              {uploading ? "Reading files…" : "Send"}
            </button>
          </div>
          <p className="composer-hint">
            <span>Enter</span> to send · <span>Shift+Enter</span> for a new line
          </p>
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

        {/* Deploy protocol is a fact about the project, not about a run. */}
        <ProjectPipelineSummary pipeline={project.deployPipeline} />
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
