/**
 * Agent core contracts.
 *
 * These types are the boundary between "what the agent believes" and "what the
 * system is allowed to do". They are internal: none of these identifiers are
 * ever rendered to the user. The conversation stays plain English; this layer
 * stays precise.
 */

import type { AccessType, KBDigest, MemoryEntry, Project, ProjectMessage, Run } from "../types";

/** How dangerous an action is. Drives the approval policy, nothing else. */
export type RiskClass = "read_only" | "low_risk_change" | "medium_risk_change" | "high_risk_change";

/** A capability is the access a tool needs before it may run at all. */
export type Capability =
  | "public_internet"
  | AccessType;

export type ToolId =
  | "public_http.inspect_site"
  | "public_http.inspect_seo_surface"
  | "browser.inspect_page_readonly"
  | "wordpress.inspect_public_surface"
  | "wordpress.list_plugins"
  | "wordpress.read_health"
  | "wordpress.read_error_log"
  | "wordpress.run_wp_cli_readonly"
  | "wordpress.execute_wp_cli"
  | "filesystem.read"
  | "filesystem.write"
  | "database.query_readonly"
  | "database.execute";

/** Everything the reasoner is allowed to look at. */
export type AgentContext = {
  project: Project;
  run: Run;
  /** Most recent conversation, oldest first. Bounded by the caller. */
  recentMessages: ProjectMessage[];
  memory: MemoryEntry[];
  /**
   * Credentials the server holds for this project. Enough to attempt a
   * read-only private call, never enough to call access "verified".
   */
  capabilities: Capability[];
  /**
   * The subset the provider has actually accepted at least once. Only these
   * may be described to a person as verified.
   */
  verifiedCapabilities?: Capability[];
  evidence: AgentEvidence[];
  /**
   * Tools that already failed or were unavailable during this investigation.
   * The reasoner uses these to stop asking for the same thing again.
   */
  failedObservations?: Array<{ toolId: ToolId; code: ToolFailureCode }>;
  /**
   * Prior incident library entries for this task type. Injected once per turn
   * by agentExecutor, passed through to reasoningDigest as priorIncidents.
   * Max 6 entries, task_type match first, then global fallback.
   */
  knowledgeBase?: KBDigest[];
  environment: {
    primaryUrl: string | null;
    executionBackendAvailable: boolean;
  };
};

export type AgentActionArguments = Record<string, string | number | boolean | null>;

/** A single proposed tool call. */
export type AgentAction = {
  /** Stable within a turn. Part of the invocation key. */
  id: string;
  toolId: ToolId;
  /** Plain-English reason this action exists. Safe to show a human. */
  purpose: string;
  capability: Capability;
  readOnly: boolean;
  risk: RiskClass;
  args: AgentActionArguments;
  /** Deterministic. Never derived from wall-clock time. */
  invocationKey: string;
  /** Read-only actions may opt into re-running instead of reusing a result. */
  refreshable?: boolean;
};

export type EvidenceSensitivity = "public" | "internal" | "restricted";

/** Normalized output of a tool. The only legitimate basis for a finding. */
export type AgentEvidence = {
  id: string;
  toolId: ToolId;
  /** Safe, human-readable one-liner. Never contains credentials. */
  summary: string;
  /** Structured, already redacted. */
  data: Record<string, unknown>;
  sensitivity: EvidenceSensitivity;
  redacted: boolean;
  observedAt: string;
};

export type ToolFailureCode =
  | "execution_backend_unavailable"
  | "capability_unavailable"
  | "secret_store_unavailable"
  | "execution_context_unavailable"
  | "unauthorized"
  | "forbidden"
  | "not_implemented"
  | "tool_unavailable"
  | "invalid_input"
  | "unsafe_destination"
  | "network_error"
  | "timeout"
  | "blocked_by_policy";

export type AgentToolResult =
  | {
      ok: true;
      evidence: AgentEvidence[];
      /** What the agent may say about this result, in plain English. */
      summary: string;
      reused?: boolean;
    }
  | {
      ok: false;
      code: ToolFailureCode;
      /** Safe explanation. Never includes secrets or raw provider errors. */
      summary: string;
      retryable: boolean;
      evidence?: AgentEvidence[];
    };

export type AgentIntent =
  | "inspect_public_surface"
  | "request_access"
  | "report_findings"
  | "await_human_decision"
  | "no_action";

export type AgentDecision = {
  intent: AgentIntent;
  rationale: string;
  /** Access the agent needs from the human, minimum set only. */
  requestedAccess?: AccessType[];
  /** What the agent will say if no action is taken. */
  message?: string[];
};

export type AgentPlan = {
  decision: AgentDecision;
  actions: AgentAction[];
  riskSummary: RiskClass;
  expectedOutcome: string;
  /** What would have to be true to call the work verified. */
  qaPlan: string[];
};

/** Why an autonomous investigation stopped. Internal; never shown verbatim. */
export type AgentStopReason =
  | "sufficient_evidence"
  | "needs_access"
  | "needs_user_input"
  | "approval_required"
  | "tool_unavailable"
  | "budget_exhausted"
  | "safe_stop";

export type AgentTurnResult = {
  /** Evidence produced during this turn. */
  learned: AgentEvidence[];
  /** True when the turn actually did something (tool ran or agent spoke). */
  acted: boolean;
  /** Set when the run cannot progress without the human. */
  awaiting: "access" | "backup" | "approval" | null;
  /** Why the loop stopped. */
  stopReason?: AgentStopReason;
  /** How many reasoning iterations the loop used. */
  iterations?: number;
  /** Lines already appended to the conversation by the orchestrator. */
  spoke: string[];
};

/** Persisted audit record of one real tool invocation. */
export type ExecutionEventStatus = "planned" | "running" | "succeeded" | "failed" | "blocked";

export type ExecutionEvent = {
  id: string;
  projectId: string;
  runId: string | null;
  toolId: ToolId;
  invocationKey: string;
  status: ExecutionEventStatus;
  risk: RiskClass;
  startedAt: string;
  finishedAt: string | null;
  /** Redacted, bounded. */
  inputSummary: string;
  outputSummary: string;
  errorCode: ToolFailureCode | null;
  evidenceRefs: string[];
  /** Redacted structured evidence, so a replay can reuse the observation. */
  evidenceData?: Record<string, unknown> | null;
};

export type NewExecutionEvent = Omit<ExecutionEvent, "id">;
