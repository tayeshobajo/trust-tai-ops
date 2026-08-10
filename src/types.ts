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
  | "qa_only";

export type RiskLevel = "safe" | "cautious" | "high_risk";

export type EnvironmentType = "production" | "staging" | "development";

export type AccessType =
  | "wordpress_admin"
  | "sftp"
  | "ssh"
  | "hosting_portal"
  | "database"
  | "cdn";

export type AccessStatus = "available" | "stale" | "missing";

export type RecommendationStatus = "open" | "reviewed" | "accepted" | "deferred" | "resolved";

export type QaVerdict = "passed" | "failed" | "partial" | "waived";

export type ProjectStatus = "active" | "watchlist" | "blocked";

export type WorkspaceTab = "overview" | "active_run" | "qa" | "history" | "memory";
export type RepositoryAdapter = "auto" | "demo" | "supabase";
export type WorkspaceView = "home" | "workspace" | "create_project" | "first_run";

export type PhaseStatus = "pending" | "active" | "completed" | "blocked" | "failed";

export type ProjectEnvironment = {
  id: string;
  name: string;
  type: EnvironmentType;
  primaryUrl: string;
  hostingProvider: string;
  wordpressVersion: string;
  phpVersion: string;
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
};

export type MemoryEntry = {
  id: string;
  title: string;
  type: "stack_note" | "incident_note" | "risk_note" | "qa_rule" | "procedure";
  importance: "medium" | "high" | "critical";
  content: string;
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
  wordpressVersion: string;
  phpVersion: string;
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
