export const RUN_STATES = [
  "intake",
  "access_check",
  "backup_gate",
  "environment_mapping",
  "diagnosis",
  "plan",
  "execution",
  "qa",
  "recommendations",
  "complete",
  "paused",
  "escalated",
  "failed",
  "rolled_back",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type TaskType =
  | "malware"
  | "performance"
  | "broken_site"
  | "plugin_theme_conflict"
  | "hardening"
  | "qa_only"
  | "deploy"
  | "migration"
  | "feature"
  | "dependency_upgrade";

/** The technology a project actually runs on. Drives copy and tool eligibility. */
export type ProjectStack = "wordpress" | "meteor" | "nextjs" | "custom";

/**
 * Stack-agnostic version facts, e.g. `{ meteor: "2.15", node: "22.22.1" }` or
 * `{ wordpress: "6.7.1", php: "8.2" }`. Replaces the WordPress-only pair.
 */
export type StackVersionInfo = Record<string, string>;

export type RiskLevel = "safe" | "cautious" | "high_risk";

export type EnvironmentType = "production" | "staging" | "development";

export type AccessType =
  | "wordpress_admin"
  | "sftp"
  | "ssh"
  | "hosting_portal"
  | "database"
  | "cdn"
  | "server_pm2"
  | "ci_cd"
  | "container";

export type AccessStatus = "available" | "stale" | "missing";

export type RecommendationStatus = "open" | "reviewed" | "accepted" | "deferred" | "resolved";

export type QaVerdict = "passed" | "failed" | "partial" | "waived";

export type ProjectStatus = "active" | "watchlist" | "blocked";

export type WorkspaceTab = "overview" | "active_run" | "qa" | "history" | "memory";
export type RepositoryAdapter = "auto" | "demo" | "supabase";
export type WorkspaceView =
  | "home"
  | "project_home"
  | "workspace"
  | "create_project"
  | "first_run"
  | "global_activity"
  | "approvals"
  | "settings";

export type PhaseStatus = "pending" | "active" | "completed" | "blocked" | "failed";

/** Operating facts that are true for any stack, not just WordPress. */
export type EnvironmentRuntime = {
  port?: number;
  processManager?: string;
  databaseProvider?: string;
  databaseName?: string;
};

export type ProjectEnvironment = {
  id: string;
  name: string;
  type: EnvironmentType;
  primaryUrl: string;
  hostingProvider: string;
  stack: ProjectStack;
  versions: StackVersionInfo;
  runtime?: EnvironmentRuntime;
  /** @deprecated legacy WordPress-only field. Read `versions.wordpress`. */
  wordpressVersion?: string;
  /** @deprecated legacy WordPress-only field. Read `versions.php`. */
  phpVersion?: string;
  cacheLayers: string[];
  notes: string;
};

export type ProjectAccessMethod = {
  id: string;
  type: AccessType;
  label: string;
  status: AccessStatus;
  authMethod: string;
  lastVerifiedAt: string;
  notes: string;
  /**
   * Points at a server-only sealed credential. It identifies a row, never a
   * value: the secret itself is unreadable from the browser.
   */
  credentialReference?: string;
};

export type MemoryEntry = {
  id: string;
  title: string;
  type: "stack_note" | "incident_note" | "risk_note" | "qa_rule" | "procedure";
  importance: "medium" | "high" | "critical";
  content: string;
  // Optional provenance. Older entries legitimately have no source.
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
};

export type MessageRole = "user" | "agent" | "system";

// Internal only. Never rendered as a raw enum in the interface.
export type MessageKind = "message" | "status_update" | "decision_request" | "decision_response";

export type ProjectMessage = {
  id: string;
  projectId: string;
  runId: string | null;
  role: MessageRole;
  kind: MessageKind;
  body: string[];
  createdAt: string;
  // Deterministic write key. Prevents duplicate agent messages on rerender.
  dedupeKey: string | null;
  // Links a persisted message back to the deterministic thread element that
  // produced it, so live cards/decisions can be rehydrated from run data.
  sourceKey: string | null;
};

export type NewProjectMessage = {
  runId: string | null;
  role: MessageRole;
  kind: MessageKind;
  body: string[];
  dedupeKey?: string | null;
  sourceKey?: string | null;
};

export type Recommendation = {
  id: string;
  category: "security" | "performance" | "stability" | "maintenance" | "process";
  priority: "medium" | "high" | "critical";
  status: RecommendationStatus;
  title: string;
  summary: string;
};

export type RiskFlag = {
  id: string;
  severity: "medium" | "high" | "critical";
  status: "open" | "monitoring" | "mitigated";
  title: string;
  summary: string;
};

export type QaRule = {
  id: string;
  name: string;
  type: "availability_check" | "login_check" | "visual_check" | "security_check" | "performance_check" | "regression_check";
  required: boolean;
  description: string;
};

export type QaResult = {
  id: string;
  name: string;
  result: "passed" | "failed" | "warning" | "skipped";
  notes: string;
};

export type QaReport = {
  verdict: QaVerdict;
  summary: string;
  unresolvedRisks: string[];
  results: QaResult[];
};

export type RunPhase = {
  id: string;
  state: RunState;
  label: string;
  summary: string;
  status: PhaseStatus;
};

export type RunFinding = {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  summary: string;
};

export type RunAction = {
  id: string;
  actor: "agent" | "operator" | "system";
  summary: string;
  outcome: "pending" | "succeeded" | "failed";
};

export type RunArtifact = {
  id: string;
  type: "backup_note" | "scan_result" | "diff_summary" | "qa_capture" | "report";
  title: string;
  summary: string;
};

export type RunApproval = {
  id: string;
  type: "high_risk_execution" | "qa_waiver" | "rollback";
  status: "pending" | "approved" | "rejected";
  reason: string;
};

/**
 * The branch protocol a project actually follows. Explicit steps, because a
 * set of booleans cannot say "feature branch -> develop -> staging verify ->
 * main -> production". This is a description, not a workflow engine.
 */
export type DeployStepKind =
  | "feature_branch"
  | "integration_branch"
  | "staging_verify"
  | "release_branch"
  | "production";

export type DeployStep = {
  kind: DeployStepKind;
  label: string;
  detail: string;
};

export type RollbackStrategy = "git_revert" | "pm2_reload" | "snapshot_restore";

export type DeployPipeline = {
  hasStaging: boolean;
  branchGated: boolean;
  autoDeployStaging: boolean;
  autoDeployProduction: boolean;
  stagingUrl?: string;
  productionUrl: string;
  integrationBranch?: string;
  productionBranch?: string;
  /** Single-number estimate. Kept for compatibility. */
  buildTimeMinutes?: number;
  /** Truthful range when a build is not one fixed number, e.g. 4-7 minutes. */
  buildTimeMinMinutes?: number;
  buildTimeMaxMinutes?: number;
  rollbackStrategy: RollbackStrategy;
  steps: DeployStep[];
};

export type Run = {
  id: string;
  title: string;
  taskType: TaskType;
  taskSummary: string;
  urgency: "normal" | "urgent" | "critical";
  environmentId: string;
  state: RunState;
  riskLevel: RiskLevel;
  backupStatus: "unconfirmed" | "confirmed_by_operator" | "evidence_attached" | "restore_point_verified";
  approvalRequired: boolean;
  nextAction: string;
  operatorPrompt: string;
  diagnosisSummary: string;
  planSummary: string;
  startedAt: string;
  updatedAt: string;
  phases: RunPhase[];
  findings: RunFinding[];
  actions: RunAction[];
  artifacts: RunArtifact[];
  approvals: RunApproval[];
  qaReport: QaReport;
  recommendations: Recommendation[];
};

export type Project = {
  id: string;
  name: string;
  clientName: string;
  primaryDomain: string;
  status: ProjectStatus;
  environmentHealth: "stable" | "watching" | "at_risk";
  environments: ProjectEnvironment[];
  deployPipeline?: DeployPipeline;
  accessMethods: ProjectAccessMethod[];
  memoryEntries: MemoryEntry[];
  recommendations: Recommendation[];
  riskFlags: RiskFlag[];
  qaRules: QaRule[];
  runs: Run[];
};

export type Organization = {
  id: string;
  name: string;
  descriptor: string;
  subdomain: string;
  projects: Project[];
};

export type RunDraft = {
  title: string;
  taskType: TaskType;
  taskSummary: string;
  urgency: "normal" | "urgent" | "critical";
  environmentId: string;
  accessReady: boolean;
  backupConfirmed: boolean;
};

export type ProjectDraft = {
  name: string;
  clientName: string;
  websiteUrl: string;
  description: string;
  hostingProvider: string;
  /** Authoritative at creation time. Everything else derives from it. */
  stack: ProjectStack;
  versions: StackVersionInfo;
  /** @deprecated legacy field kept so old persisted drafts still parse. */
  wordpressVersion?: string;
  /** @deprecated legacy field kept so old persisted drafts still parse. */
  phpVersion?: string;
  createProductionEnvironment: boolean;
  accessSelections: Array<{
    type: AccessType;
    enabled: boolean;
  }>;
};

export type RepositoryHealth = {
  adapter: Exclude<RepositoryAdapter, "auto">;
  ok: boolean;
  message: string;
};

export type UserRole = "viewer" | "operator" | "senior_operator" | "admin";

export type AuthState = {
  adapter: Exclude<RepositoryAdapter, "auto">;
  isAuthenticated: boolean;
  userEmail: string | null;
  userId: string | null;
  role: UserRole | null;
  status: "loading" | "ready" | "error";
  message: string;
};

// ---------------------------------------------------------------------------
// Conversation evidence
// ---------------------------------------------------------------------------

export type EvidenceKind = "image" | "video" | "pdf" | "text" | "log" | "har" | "json" | "csv" | "other";

export type EvidenceStatus = "uploading" | "stored" | "analyzing" | "ready" | "failed" | "unsupported";

/** The bounded, redacted reading of one attachment. Never raw file content. */
export type EvidenceAnalysis = {
  status: "complete" | "unavailable" | "unsupported" | "failed";
  summary: string;
  observations: string[];
  extractedTextExcerpt: string;
  technicalSignals: string[];
  confidence: "low" | "medium" | "high";
  warnings: string[];
  unsupportedReason: string | null;
};

export type ProjectEvidence = {
  id: string;
  projectId: string;
  messageId: string | null;
  runId: string | null;
  filename: string;
  mimeType: string;
  kind: EvidenceKind;
  sizeBytes: number;
  status: EvidenceStatus;
  analysis: EvidenceAnalysis | null;
  createdAt: string;
};
