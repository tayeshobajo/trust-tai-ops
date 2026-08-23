import type { PostgrestError } from "@supabase/supabase-js";
import { hasSupabasePublicConfig, isDemoModeAllowed, resolveOpsEnv } from "./env";
import { createProjectFromDraft, createRunFromDraft, getActiveRun, getProjectById, getQueuedRuns, injectProjectIntoWorkspace, isQueuedRun } from "./lib";
import { advanceRunState } from "./operations";
import { createSeedWorkspace } from "./seed";
import { getSupabaseClient } from "./supabase";

/** The database ids are uuids; anything else is rejected on write. */
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
import { redactBody } from "./agent-core/secretGuard";
import { executionGateway } from "./agent-core/gateway";
import { isProjectStack, normalizeVersions } from "./stacks";
import type {
  AccessType,
  KBEntry,
  MemoryEntry,
  NewProjectMessage,
  Organization,
  Project,
  ProjectAccessMethod,
  ProjectEnvironment,
  ProjectMessage,
  QaReport,
  QaResult,
  QaRule,
  Recommendation,
  RepositoryHealth,
  RiskFlag,
  Run,
  RunAction,
  RunApproval,
  RunArtifact,
  RunDraft,
  RunFinding,
  RunPhase,
  ProjectDraft,
} from "./types";
import type { ExecutionEvent, NewExecutionEvent } from "./agent-core/types";

const KNOWLEDGE_BASE_STORAGE_KEY = "tt-ops.knowledge-base.v1";
import type { RunPlan } from "./agent-core/plan";

const STORAGE_KEY = "ops-trust-tai.workspace";
const MESSAGE_STORAGE_KEY = "ops-trust-tai.messages";
const EXECUTION_STORAGE_KEY = "ops-trust-tai.execution-events";
const RUN_PLAN_STORAGE_KEY = "ops-trust-tai.run-plans";

type OrganizationRow = {
  id: string;
  name: string;
  descriptor: string;
  subdomain: string;
};

type ProjectRow = {
  id: string;
  organization_id: string;
  name: string;
  client_name: string;
  primary_domain: string;
  status: Project["status"];
  environment_health: Project["environmentHealth"];
  deploy_pipeline?: Project["deployPipeline"] | null;
  trust_tai_os_project_id?: string | null;
};

type ProjectEnvironmentRow = {
  id: string;
  project_id: string;
  name: string;
  environment_type: ProjectEnvironment["type"];
  primary_url: string;
  hosting_provider: string;
  stack?: ProjectEnvironment["stack"] | null;
  versions?: Record<string, string> | null;
  runtime?: ProjectEnvironment["runtime"] | null;
  wordpress_version?: string | null;
  php_version?: string | null;
  cache_layers: string[] | null;
  notes: string;
};

type ProjectAccessMethodRow = {
  id: string;
  project_id: string;
  access_type: ProjectAccessMethod["type"];
  label: string;
  status: ProjectAccessMethod["status"];
  auth_method: string;
  last_verified_at: string | null;
  notes: string;
  credential_reference?: string | null;
};

type MemoryEntryRow = {
  id: string;
  project_id: string;
  memory_type: MemoryEntry["type"];
  importance: MemoryEntry["importance"];
  title: string;
  content: string;
  source_run_id?: string | null;
  source_message_id?: string | null;
};

type ProjectMessageRow = {
  id: string;
  project_id: string;
  run_id: string | null;
  role: ProjectMessage["role"];
  kind: ProjectMessage["kind"];
  body: string[] | null;
  dedupe_key: string | null;
  source_key: string | null;
  created_at: string;
};

type QaRuleRow = {
  id: string;
  project_id: string;
  name: string;
  rule_type: QaRule["type"];
  required: boolean;
  description: string;
};

type RiskFlagRow = {
  id: string;
  project_id: string;
  severity: RiskFlag["severity"];
  status: RiskFlag["status"];
  title: string;
  summary: string;
  created_at: string;
};

type RecommendationRow = {
  id: string;
  project_id?: string;
  run_id?: string;
  category: Recommendation["category"];
  priority: Recommendation["priority"];
  status: Recommendation["status"];
  title: string;
  summary: string;
};

type RunRow = {
  id: string;
  project_id: string;
  environment_id: string;
  title: string;
  task_type: Run["taskType"];
  task_summary: string;
  urgency: Run["urgency"];
  state: Run["state"];
  risk_level: Run["riskLevel"];
  backup_status: Run["backupStatus"];
  approval_required: boolean;
  next_action: string;
  operator_prompt: string;
  diagnosis_summary: string;
  plan_summary: string;
  started_at: string;
  updated_at: string;
  queue_position?: number | null;
};


type RunPhaseRow = {
  id: string;
  run_id: string;
  state: RunPhase["state"];
  label: string;
  summary: string;
  status: RunPhase["status"];
};

type RunFindingRow = {
  id: string;
  run_id: string;
  severity: RunFinding["severity"];
  title: string;
  summary: string;
};

type RunActionRow = {
  id: string;
  run_id: string;
  actor: RunAction["actor"];
  summary: string;
  outcome: RunAction["outcome"];
};

type RunArtifactRow = {
  id: string;
  run_id: string;
  artifact_type: RunArtifact["type"];
  title: string;
  summary: string;
};

type RunApprovalRow = {
  id: string;
  run_id: string;
  approval_type: RunApproval["type"];
  status: RunApproval["status"];
  reason: string;
};

type QaReportRow = {
  id: string;
  run_id: string;
  verdict: QaReport["verdict"];
  summary: string;
  unresolved_risks: string[] | null;
};

type QaResultRow = {
  id: string;
  qa_report_id: string;
  name: string;
  result: QaResult["result"];
  notes: string;
};

export interface WorkspaceRepository {
  health(): Promise<RepositoryHealth>;
  loadWorkspace(): Promise<Organization>;
  saveWorkspace(workspace: Organization): Promise<void>;
  createProject(draft: ProjectDraft): Promise<Organization>;
  /**
   * Creates a task. When `options.queued` is set the task waits its turn: the
   * agent only ever works on the one live task in a project.
   */
  createRun(projectId: string, draft: RunDraft, options?: { queued?: boolean }): Promise<Organization>;
  /** Starts a waiting task now, parking whatever was live back at the front of the queue. */
  promoteQueuedRun(projectId: string, runId: string): Promise<Organization>;
  /** Moves a waiting task up or down the queue. */
  moveQueuedRun(projectId: string, runId: string, direction: "up" | "down"): Promise<Organization>;
  /** Drops a waiting task without ever starting it. */
  cancelQueuedRun(projectId: string, runId: string): Promise<Organization>;

  getProject(projectId: string): Promise<Project | null>;
  getActiveRun(projectId: string): Promise<Run | null>;
  advanceRun(projectId: string, runId: string, targetState: Run["state"]): Promise<Organization>;
  confirmBackup(projectId: string, runId: string, note: string): Promise<Organization>;
  approveRun(projectId: string, runId: string, approvalType: "high_risk_execution" | "qa_waiver" | "rollback", decision: "approved" | "rejected", reason: string): Promise<Organization>;
  rollbackRun(projectId: string, runId: string, reason: string): Promise<Organization>;
  /**
   * A human declaring the work already done outside the agent. It closes the
   * task without pretending the agent verified anything, so Ops stops raising it.
   */
  closeRunManually(projectId: string, runId: string, note: string): Promise<Organization>;
  updateQaResult(projectId: string, runId: string, resultId: string, result: "passed" | "failed" | "warning" | "skipped", notes: string): Promise<Organization>;
  setQaVerdict(projectId: string, runId: string, verdict: "passed" | "failed" | "partial" | "waived", summary: string): Promise<Organization>;
  addEvidence(projectId: string, runId: string, artifactType: "backup_note" | "scan_result" | "diff_summary" | "qa_capture" | "report" | "fix_plan" | "execution_failed", title: string, summary: string): Promise<Organization>;
  getRecentEvidence(projectId: string, runId: string, artifactType: string, limit: number): Promise<Array<{ summary: string }>>;
  addRecommendation(projectId: string, runId: string | null, category: Recommendation["category"], priority: Recommendation["priority"], title: string, summary: string): Promise<Organization>;
  addMemoryEntry(projectId: string, entry: { title: string; type: MemoryEntry["type"]; importance: MemoryEntry["importance"]; content: string; sourceRunId?: string | null; sourceMessageId?: string | null }): Promise<Organization>;
  saveAccessMethod(projectId: string, method: ProjectAccessMethod): Promise<Organization>;
  removeAccessMethod(projectId: string, methodId: string): Promise<Organization>;
  /**
   * Records a human re-confirmation of a metadata-only access note.
   *
   * It cannot verify an executable credential: proving a WordPress Application
   * Password is a server-side act, and the browser is not allowed to claim it.
   */
  verifyAccessMethod(projectId: string, methodId: string, accessType?: AccessType): Promise<Organization>;
  /**
   * Reconciles an access method with an outcome the server produced.
   *
   * The browser never decides this: the only input is a verification result
   * that came back from the `access-secrets` function. On the native adapter
   * the server has already written the row, so this is a pure re-read. On the
   * local adapter — where there is no database and no real credential — the
   * server-attested outcome is applied to the local fixture so the rendered
   * card tells the same truth the server just told.
   */
  applyServerVerification(
    projectId: string,
    accessType: AccessType,
    outcome: { state: "verified" | "rejected" | "unverified"; lastVerifiedAt: string | null },
  ): Promise<Organization>;
  listProjectMessages(projectId: string): Promise<ProjectMessage[]>;
  listRunMessages(projectId: string, runId: string): Promise<ProjectMessage[]>;
  addProjectMessage(projectId: string, message: NewProjectMessage): Promise<ProjectMessage>;
  listExecutionEvents(projectId: string, runId?: string): Promise<ExecutionEvent[]>;
  findExecutionEvent(projectId: string, invocationKey: string): Promise<ExecutionEvent | null>;
  /** Upserts on the deterministic invocation key. */
  saveExecutionEvent(projectId: string, event: NewExecutionEvent): Promise<ExecutionEvent>;
  /** The agent's living working plan for a run. Null until the agent writes one. */
  loadRunPlan(projectId: string, runId: string): Promise<RunPlan | null>;
  saveRunPlan(plan: RunPlan): Promise<RunPlan>;
  /**
   * Cross-project incident library. Read path for the reasoning digest;
   * write path runs service-role in the orchestrator via edge function.
   * projectId proves the caller's membership — the library itself is global.
   */
  listKnowledgeBase(projectId: string, taskType?: string): Promise<KBEntry[]>;
  upsertKnowledgeBaseEntry(projectId: string, entry: {
    taskType: string;
    symptomPattern: string;
    resolution: string;
    evidenceSignals: string[];
    toolsUsed: string[];
    hostContext?: string | null;
  }): Promise<void>;
}

class LocalWorkspaceRepository implements WorkspaceRepository {
  async health(): Promise<RepositoryHealth> {
    return {
      adapter: "demo",
      ok: true,
      message: "Demo adapter active. Workspace is using local browser persistence.",
    };
  }

  async loadWorkspace(): Promise<Organization> {
    if (typeof window === "undefined") {
      return createSeedWorkspace();
    }

    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return createSeedWorkspace();
    }

    try {
      return JSON.parse(raw) as Organization;
    } catch {
      return createSeedWorkspace();
    }
  }

  async saveWorkspace(workspace: Organization): Promise<void> {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }

  async createRun(projectId: string, draft: RunDraft, options?: { queued?: boolean }): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);

    if (!project) {
      return workspace;
    }

    const created = createRunFromDraft(draft, project);
    const newRun: Run = options?.queued
      ? { ...created, queuePosition: nextQueuePosition(project) }
      : created;
    const nextWorkspace = injectRunIntoWorkspace(workspace, projectId, newRun);
    await this.saveWorkspace(nextWorkspace);

    return nextWorkspace;
  }

  async promoteQueuedRun(projectId: string, runId: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const target = project.runs.find((run) => run.id === runId);
    if (!target || !isQueuedRun(target)) return workspace;

    const live = getActiveRun(project);
    const parkLive = live && live.state !== "complete";

    return this.writeRuns(projectId, project.runs.map((run) => {
      if (run.id === target.id) return { ...run, queuePosition: null };
      if (parkLive && live && run.id === live.id) return { ...run, queuePosition: -1 };
      return run;
    }));
  }

  async moveQueuedRun(projectId: string, runId: string, direction: "up" | "down"): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const queue = getQueuedRuns(project);
    const index = queue.findIndex((run) => run.id === runId);
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (index === -1 || swapWith < 0 || swapWith >= queue.length) return workspace;

    const reordered = queue.slice();
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
    const positions = new Map(reordered.map((run, order) => [run.id, order]));

    return this.writeRuns(projectId, project.runs.map((run) =>
      positions.has(run.id) ? { ...run, queuePosition: positions.get(run.id) ?? null } : run,
    ));
  }

  async cancelQueuedRun(projectId: string, runId: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    return this.writeRuns(projectId, project.runs.filter((run) => run.id !== runId || !isQueuedRun(run)));
  }

  private async writeRuns(projectId: string, runs: Run[]): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const next: Organization = {
      ...workspace,
      projects: workspace.projects.map((candidate) =>
        candidate.id === projectId ? { ...candidate, runs } : candidate,
      ),
    };
    await this.saveWorkspace(next);
    return next;
  }


  async createProject(draft: ProjectDraft): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const newProject = createProjectFromDraft(draft);
    const nextWorkspace = injectProjectIntoWorkspace(workspace, newProject);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const workspace = await this.loadWorkspace();
    return getProjectById(workspace, projectId);
  }

  async getActiveRun(projectId: string): Promise<Run | null> {
    const project = await this.getProject(projectId);
    return getActiveRun(project);
  }

  async advanceRun(projectId: string, runId: string, targetState: Run["state"]): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const updatedRun = advanceRunState(run, targetState);
    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async confirmBackup(projectId: string, runId: string, note: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const updatedRun: Run = {
      ...run,
      backupStatus: "confirmed_by_operator",
      artifacts: [...run.artifacts, {
        id: `artifact-${runId}-${Date.now()}`,
        type: "backup_note",
        title: "Backup confirmed",
        summary: note,
      }],
      updatedAt: new Date().toISOString(),
    };

    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async approveRun(projectId: string, runId: string, approvalType: "high_risk_execution" | "qa_waiver" | "rollback", decision: "approved" | "rejected", reason: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const approval: RunApproval = {
      id: `approval-${runId}-${Date.now()}`,
      type: approvalType,
      status: decision,
      reason,
    };

    const updatedRun: Run = {
      ...run,
      approvals: [...run.approvals, approval],
      approvalRequired: approvalType === "high_risk_execution" && decision === "approved" ? false : run.approvalRequired,
      updatedAt: new Date().toISOString(),
    };

    // If QA waiver approved, allow completion
    if (approvalType === "qa_waiver" && decision === "approved") {
      updatedRun.qaReport = { ...updatedRun.qaReport, verdict: "waived", summary: `QA waived: ${reason}` };
    }

    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async rollbackRun(projectId: string, runId: string, reason: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const updatedRun = advanceRunState(run, "rolled_back");
    updatedRun.findings = [...run.findings, {
      id: `finding-${runId}-${Date.now()}`,
      severity: "high",
      title: "Rollback executed",
      summary: reason,
    }];
    updatedRun.actions = [...run.actions, {
      id: `action-${runId}-${Date.now()}`,
      actor: "operator",
      summary: `Rolled back: ${reason}`,
      outcome: "succeeded",
    }];

    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async closeRunManually(projectId: string, runId: string, note: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;
    if (run.state === "complete") return workspace;

    const updatedRun: Run = {
      ...run,
      state: "complete",
      phases: run.phases.map((phase) => ({ ...phase, status: "completed" })),
      nextAction: "Closed by the operator. Nothing further is queued.",
      updatedAt: new Date().toISOString(),
      actions: [...run.actions, {
        id: `action-${runId}-${Date.now()}`,
        actor: "operator",
        summary: note,
        outcome: "succeeded",
      }],
    };

    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }



  async updateQaResult(projectId: string, runId: string, resultId: string, result: "passed" | "failed" | "warning" | "skipped", notes: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const updatedResults = run.qaReport.results.map((r) =>
      r.id === resultId ? { ...r, result, notes } : r,
    );
    const updatedRun: Run = {
      ...run,
      qaReport: { ...run.qaReport, results: updatedResults },
      updatedAt: new Date().toISOString(),
    };
    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async setQaVerdict(projectId: string, runId: string, verdict: "passed" | "failed" | "partial" | "waived", summary: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const updatedRun: Run = {
      ...run,
      qaReport: { ...run.qaReport, verdict, summary },
      updatedAt: new Date().toISOString(),
    };
    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async getRecentEvidence(_projectId: string, _runId: string, _artifactType: string, _limit: number): Promise<Array<{ summary: string }>> {
    // In-memory demo: no persistent evidence store.
    return [];
  }

  async addEvidence(projectId: string, runId: string, artifactType: "backup_note" | "scan_result" | "diff_summary" | "qa_capture" | "report" | "fix_plan" | "execution_failed", title: string, summary: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { project, run } = findRun(workspace, projectId, runId);
    if (!project || !run) return workspace;

    const updatedRun: Run = {
      ...run,
      artifacts: [...run.artifacts, {
        id: `artifact-${runId}-${Date.now()}`,
        type: artifactType,
        title,
        summary,
      }],
      updatedAt: new Date().toISOString(),
    };
    const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async addRecommendation(projectId: string, runId: string | null, category: Recommendation["category"], priority: Recommendation["priority"], title: string, summary: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const newRec: Recommendation = {
      id: `rec-${projectId}-${Date.now()}`,
      category,
      priority,
      status: "open",
      title,
      summary,
    };

    if (runId) {
      const { run } = findRun(workspace, projectId, runId);
      if (run) {
        const updatedRun: Run = { ...run, recommendations: [...run.recommendations, newRec], updatedAt: new Date().toISOString() };
        const nextWorkspace = replaceRun(workspace, projectId, updatedRun);
        await this.saveWorkspace(nextWorkspace);
        return nextWorkspace;
      }
    }

    // Project-level recommendation
    const updatedProject: Project = { ...project, recommendations: [...project.recommendations, newRec] };
    const nextWorkspace: Organization = {
      ...workspace,
      projects: workspace.projects.map((p) => p.id === projectId ? updatedProject : p),
    };
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async addMemoryEntry(projectId: string, entry: { title: string; type: MemoryEntry["type"]; importance: MemoryEntry["importance"]; content: string; sourceRunId?: string | null; sourceMessageId?: string | null }): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const newEntry: MemoryEntry = {
      id: `memory-${projectId}-${Date.now()}`,
      ...entry,
    };

    const updatedProject: Project = { ...project, memoryEntries: [...project.memoryEntries, newEntry] };
    const nextWorkspace: Organization = {
      ...workspace,
      projects: workspace.projects.map((p) => p.id === projectId ? updatedProject : p),
    };
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async saveAccessMethod(projectId: string, method: ProjectAccessMethod): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const exists = project.accessMethods.some((item) => item.id === method.id);
    const accessMethods = exists
      ? project.accessMethods.map((item) => (item.id === method.id ? method : item))
      : [...project.accessMethods, method];

    const nextWorkspace: Organization = {
      ...workspace,
      projects: workspace.projects.map((p) => (p.id === projectId ? { ...p, accessMethods } : p)),
    };
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async removeAccessMethod(projectId: string, methodId: string): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const nextWorkspace: Organization = {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id === projectId ? { ...p, accessMethods: p.accessMethods.filter((item) => item.id !== methodId) } : p,
      ),
    };
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async verifyAccessMethod(projectId: string, methodId: string, accessType?: AccessType): Promise<Organization> {
    // Demo adapter. Nothing here is real verification, and nothing here can
    // reach the native path — the seeded workspace lives in this browser only.
    if (accessType === "wordpress_admin") return this.loadWorkspace();
    const workspace = await this.loadWorkspace();
    const stamp = new Date().toISOString();
    const nextWorkspace: Organization = {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              accessMethods: p.accessMethods.map((item) =>
                item.id === methodId ? { ...item, status: "available" as const, lastVerifiedAt: stamp } : item,
              ),
            }
          : p,
      ),
    };
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  async applyServerVerification(
    projectId: string,
    accessType: AccessType,
    outcome: { state: "verified" | "rejected" | "unverified"; lastVerifiedAt: string | null },
  ): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    // An unreachable check changed nothing on the server, so it changes
    // nothing here either.
    if (outcome.state === "unverified") return workspace;
    // "Verified" without a server timestamp is not a verification. Refusing is
    // the only safe reading of a malformed outcome.
    if (outcome.state === "verified" && !outcome.lastVerifiedAt) return workspace;

    const nextWorkspace: Organization = {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id !== projectId
          ? p
          : {
              ...p,
              accessMethods: p.accessMethods.map((item) =>
                item.type !== accessType
                  ? item
                  : outcome.state === "verified"
                    ? { ...item, status: "available" as const, lastVerifiedAt: outcome.lastVerifiedAt as string }
                    : // A rejection is a real fact too: the stamp is cleared and
                      // the card is asked for attention.
                      { ...item, status: "stale" as const, lastVerifiedAt: "" },
              ),
            },
      ),
    };
    await this.saveWorkspace(nextWorkspace);
    return nextWorkspace;
  }

  private readMessageStore(): Record<string, ProjectMessage[]> {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(MESSAGE_STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, ProjectMessage[]>;
    } catch {
      return {};
    }
  }

  private writeMessageStore(store: Record<string, ProjectMessage[]>): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MESSAGE_STORAGE_KEY, JSON.stringify(store));
  }

  async listProjectMessages(projectId: string): Promise<ProjectMessage[]> {
    return sortByCreatedAt(this.readMessageStore()[projectId] ?? []);
  }

  async listRunMessages(projectId: string, runId: string): Promise<ProjectMessage[]> {
    const messages = await this.listProjectMessages(projectId);
    return messages.filter((message) => message.runId === runId);
  }

  async addProjectMessage(projectId: string, message: NewProjectMessage): Promise<ProjectMessage> {
    // Last net: a secret value can never become a stored message, whoever
    // called this and however the text got here.
    message = { ...message, body: redactBody(message.body) };
    const store = this.readMessageStore();
    const existing = store[projectId] ?? [];
    const dedupeKey = message.dedupeKey ?? null;

    if (dedupeKey) {
      const match = existing.find((item) => item.dedupeKey === dedupeKey);
      if (match) return match;
    }

    const saved: ProjectMessage = {
      id: createMessageId(),
      projectId,
      runId: message.runId ?? null,
      role: message.role,
      kind: message.kind,
      body: message.body,
      createdAt: new Date().toISOString(),
      dedupeKey,
      sourceKey: message.sourceKey ?? null,
    };

    this.writeMessageStore({ ...store, [projectId]: [...existing, saved] });
    return saved;
  }

  private readExecutionStore(): Record<string, ExecutionEvent[]> {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(EXECUTION_STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, ExecutionEvent[]>;
    } catch {
      return {};
    }
  }

  private writeExecutionStore(store: Record<string, ExecutionEvent[]>): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(EXECUTION_STORAGE_KEY, JSON.stringify(store));
  }

  async listExecutionEvents(projectId: string, runId?: string): Promise<ExecutionEvent[]> {
    const events = this.readExecutionStore()[projectId] ?? [];
    return runId ? events.filter((event) => event.runId === runId) : events;
  }

  async findExecutionEvent(projectId: string, invocationKey: string): Promise<ExecutionEvent | null> {
    const events = await this.listExecutionEvents(projectId);
    return events.find((event) => event.invocationKey === invocationKey) ?? null;
  }

  async saveExecutionEvent(projectId: string, event: NewExecutionEvent): Promise<ExecutionEvent> {
    const store = this.readExecutionStore();
    const existing = store[projectId] ?? [];
    const match = existing.find((item) => item.invocationKey === event.invocationKey);
    const saved: ExecutionEvent = { ...event, id: match?.id ?? createMessageId() };
    const next = match
      ? existing.map((item) => (item.id === match.id ? saved : item))
      : [...existing, saved];
    this.writeExecutionStore({ ...store, [projectId]: next });
    return saved;
  }

  private readPlanStore(): Record<string, RunPlan> {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(RUN_PLAN_STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, RunPlan>;
    } catch {
      return {};
    }
  }

  async loadRunPlan(projectId: string, runId: string): Promise<RunPlan | null> {
    return this.readPlanStore()[`${projectId}:${runId}`] ?? null;
  }

  async saveRunPlan(plan: RunPlan): Promise<RunPlan> {
    if (typeof window === "undefined") return plan;
    const store = this.readPlanStore();
    const saved: RunPlan = { ...plan, updatedAt: new Date().toISOString() };
    store[`${plan.projectId}:${plan.runId}`] = saved;
    window.localStorage.setItem(RUN_PLAN_STORAGE_KEY, JSON.stringify(store));
    return saved;
  }

  async listKnowledgeBase(_projectId: string, taskType?: string): Promise<KBEntry[]> {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(KNOWLEDGE_BASE_STORAGE_KEY);
    if (!raw) return [];
    try {
      const all = JSON.parse(raw) as KBEntry[];
      return taskType ? all.filter((entry) => entry.taskType === taskType) : all;
    } catch {
      return [];
    }
  }

  async upsertKnowledgeBaseEntry(_projectId: string, entry: {
    taskType: string;
    symptomPattern: string;
    resolution: string;
    evidenceSignals: string[];
    toolsUsed: string[];
    hostContext?: string | null;
  }): Promise<void> {
    if (typeof window === "undefined") return;
    const all = await this.listKnowledgeBase(_projectId);
    const normalized = entry.symptomPattern.trim().toLowerCase();
    const match = all.find(
      (existing) =>
        existing.taskType === entry.taskType &&
        existing.symptomPattern.trim().toLowerCase() === normalized,
    );
    const now = new Date().toISOString();
    if (match) {
      match.projectCount += 1;
      match.lastConfirmedAt = now;
      match.updatedAt = now;
      // Keep the longer resolution — richer description wins.
      if (entry.resolution.length > match.resolution.length) match.resolution = entry.resolution;
      window.localStorage.setItem(KNOWLEDGE_BASE_STORAGE_KEY, JSON.stringify(all));
      return;
    }
    const next: KBEntry = {
      id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scope: "global",
      taskType: entry.taskType,
      symptomPattern: entry.symptomPattern,
      resolution: entry.resolution,
      evidenceSignals: entry.evidenceSignals,
      toolsUsed: entry.toolsUsed,
      hostContext: entry.hostContext ?? null,
      projectCount: 1,
      lastConfirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    all.push(next);
    window.localStorage.setItem(KNOWLEDGE_BASE_STORAGE_KEY, JSON.stringify(all));
  }
}

class SupabaseWorkspaceRepository implements WorkspaceRepository {
  async health(): Promise<RepositoryHealth> {
    const client = getSupabaseClient();
    const env = resolveOpsEnv();
    const { error } = await client
      .from("organizations")
      .select("id")
      .eq("subdomain", env.subdomain)
      .limit(1);

    if (error) {
      return {
        adapter: "supabase",
        ok: false,
        message: summarizeSupabaseError(error),
      };
    }

    return {
      adapter: "supabase",
      ok: true,
      message: `Supabase adapter active for ${env.subdomain}.`,
    };
  }

  async loadWorkspace(): Promise<Organization> {
    const client = getSupabaseClient();
    const env = resolveOpsEnv();

    const { data: organizationRow, error: organizationError } = await client
      .from("organizations")
      .select("*")
      .eq("subdomain", env.subdomain)
      .maybeSingle();

    if (organizationError) {
      throw organizationError;
    }

    if (!organizationRow) {
      throw new Error(`No organization found for subdomain ${env.subdomain}.`);
    }

    const organization = organizationRow as OrganizationRow;

    const { data: projectRows, error: projectError } = await client
      .from("projects")
      .select("*")
      .eq("organization_id", organization.id)
      .order("name");

    if (projectError) {
      throw projectError;
    }

    const projects = (projectRows ?? []) as ProjectRow[];
    const projectIds = projects.map((project) => project.id);

    if (projectIds.length === 0) {
      return {
        id: organization.id,
        name: organization.name,
        descriptor: organization.descriptor,
        subdomain: organization.subdomain,
        projects: [],
      };
    }

    const [
      environmentRows,
      accessRows,
      memoryRows,
      qaRuleRows,
      riskRows,
      projectRecommendationRows,
      runRows,
    ] = await Promise.all([
      this.selectIn<ProjectEnvironmentRow>("project_environments", "project_id", projectIds),
      this.selectIn<ProjectAccessMethodRow>("project_access_methods", "project_id", projectIds),
      this.selectIn<MemoryEntryRow>("project_memory_entries", "project_id", projectIds),
      this.selectIn<QaRuleRow>("qa_rules", "project_id", projectIds),
      this.selectIn<RiskFlagRow>("project_risk_flags", "project_id", projectIds),
      this.selectIn<RecommendationRow>("project_recommendations", "project_id", projectIds),
      this.selectIn<RunRow>("runs", "project_id", projectIds, "started_at", false),
    ]);

    const runIds = runRows.map((run) => run.id);

    const [
      phaseRows,
      findingRows,
      actionRows,
      artifactRows,
      approvalRows,
      qaReportRows,
      runRecommendationRows,
    ] = await Promise.all([
      runIds.length > 0 ? this.selectIn<RunPhaseRow>("run_phases", "run_id", runIds) : Promise.resolve([]),
      runIds.length > 0 ? this.selectIn<RunFindingRow>("run_findings", "run_id", runIds) : Promise.resolve([]),
      runIds.length > 0 ? this.selectIn<RunActionRow>("run_actions", "run_id", runIds) : Promise.resolve([]),
      runIds.length > 0 ? this.selectIn<RunArtifactRow>("run_artifacts", "run_id", runIds) : Promise.resolve([]),
      runIds.length > 0 ? this.selectIn<RunApprovalRow>("run_approvals", "run_id", runIds) : Promise.resolve([]),
      runIds.length > 0 ? this.selectIn<QaReportRow>("qa_reports", "run_id", runIds) : Promise.resolve([]),
      runIds.length > 0 ? this.selectIn<RecommendationRow>("run_recommendations", "run_id", runIds) : Promise.resolve([]),
    ]);

    const qaReportIds = qaReportRows.map((report) => report.id);
    const qaResultRows = qaReportIds.length > 0
      ? await this.selectIn<QaResultRow>("qa_results", "qa_report_id", qaReportIds)
      : [];

    return {
      id: organization.id,
      name: organization.name,
      descriptor: organization.descriptor,
      subdomain: organization.subdomain,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        clientName: project.client_name,
        primaryDomain: project.primary_domain,
        status: project.status,
        environmentHealth: project.environment_health,
        trustTaiOsProjectId: project.trust_tai_os_project_id ?? null,
        deployPipeline: project.deploy_pipeline ?? undefined,
        environments: environmentRows
          .filter((environment) => environment.project_id === project.id)
          .map(mapEnvironment),
        accessMethods: accessRows
          .filter((access) => access.project_id === project.id)
          .map(mapAccessMethod),
        memoryEntries: memoryRows
          .filter((entry) => entry.project_id === project.id)
          .map(mapMemoryEntry),
        recommendations: projectRecommendationRows
          .filter((recommendation) => recommendation.project_id === project.id)
          .map(mapRecommendation),
        riskFlags: riskRows
          .filter((risk) => risk.project_id === project.id)
          .map(mapRiskFlag),
        qaRules: qaRuleRows
          .filter((rule) => rule.project_id === project.id)
          .map(mapQaRule),
        runs: runRows
          .filter((run) => run.project_id === project.id)
          .map((run) => mapRun(run, {
            phaseRows,
            findingRows,
            actionRows,
            artifactRows,
            approvalRows,
            qaReportRows,
            qaResultRows,
            runRecommendationRows,
          })),
      })),
    };
  }

  async saveWorkspace(): Promise<void> {
    return;
  }

  async createRun(projectId: string, draft: RunDraft, options?: { queued?: boolean }): Promise<Organization> {
    const client = getSupabaseClient();
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);

    if (!project) {
      return workspace;
    }

    const newRun = createRunFromDraft(draft, project);
    // Postgres ids are uuid columns; the client-side factories use readable
    // slug ids, so mint real uuids at the database boundary.
    const runId = crypto.randomUUID();

    const { error: runError } = await client.from("runs").insert([{
      id: runId,
      project_id: projectId,
      environment_id: newRun.environmentId,
      title: newRun.title,
      task_type: newRun.taskType,
      task_summary: newRun.taskSummary,
      urgency: newRun.urgency,
      state: newRun.state,
      risk_level: newRun.riskLevel,
      backup_status: newRun.backupStatus,
      approval_required: newRun.approvalRequired,
      next_action: newRun.nextAction,
      operator_prompt: newRun.operatorPrompt,
      diagnosis_summary: newRun.diagnosisSummary,
      plan_summary: newRun.planSummary,
      started_at: newRun.startedAt,
      updated_at: newRun.updatedAt,
      queue_position: options?.queued ? nextQueuePosition(project) : null,
    }] as never);


    if (runError) {
      throw runError;
    }

    await Promise.all([
      insertRows(client.from("run_phases").insert(newRun.phases.map((phase) => ({
        id: crypto.randomUUID(),
        run_id: runId,
        state: phase.state,
        label: phase.label,
        summary: phase.summary,
        status: phase.status,
      })) as never)),
      insertRows(client.from("run_actions").insert(newRun.actions.map((action) => ({
        id: crypto.randomUUID(),
        run_id: runId,
        actor: action.actor,
        summary: action.summary,
        outcome: action.outcome,
      })) as never)),
      insertRows(client.from("run_artifacts").insert(newRun.artifacts.map((artifact) => ({
        id: crypto.randomUUID(),
        run_id: runId,
        artifact_type: artifact.type,
        title: artifact.title,
        summary: artifact.summary,
      })) as never)),
    ]);

    const qaReportId = crypto.randomUUID();
    const { error: qaReportError } = await client
      .from("qa_reports")
      .insert([{
        id: qaReportId,
        run_id: runId,
        verdict: newRun.qaReport.verdict,
        summary: newRun.qaReport.summary,
        unresolved_risks: newRun.qaReport.unresolvedRisks,
      }] as never);

    if (qaReportError) {
      throw qaReportError;
    }

    await insertRows(client.from("qa_results").insert(newRun.qaReport.results.map((result) => ({
      id: crypto.randomUUID(),
      qa_report_id: qaReportId,
      name: result.name,
      result: result.result,
      notes: result.notes,
    })) as never));

    return this.loadWorkspace();
  }

  async createProject(draft: ProjectDraft): Promise<Organization> {
    const client = getSupabaseClient();
    const workspace = await this.loadWorkspace();
    const newProject = createProjectFromDraft(draft);
    // Database ids are uuids; map the readable factory ids onto real uuids so
    // every child row points at the same generated identifiers.
    const projectId = crypto.randomUUID();
    const environmentIds = new Map<string, string>(
      newProject.environments.map((environment) => [environment.id, crypto.randomUUID()]),
    );
    const firstEnvironmentId = newProject.environments[0]
      ? environmentIds.get(newProject.environments[0].id) ?? null
      : null;

    const { error: projectError } = await client.from("projects").insert([{
      id: projectId,
      organization_id: workspace.id,
      name: newProject.name,
      client_name: newProject.clientName,
      primary_domain: newProject.primaryDomain,
      status: newProject.status,
      environment_health: newProject.environmentHealth,
      deploy_pipeline: newProject.deployPipeline ?? null,
    }] as never);

    if (projectError) {
      throw projectError;
    }

    if (newProject.environments.length > 0) {
      await insertRows(client.from("project_environments").insert(newProject.environments.map((environment) => ({
        id: environmentIds.get(environment.id) ?? crypto.randomUUID(),
        project_id: projectId,
        name: environment.name,
        environment_type: environment.type,
        primary_url: environment.primaryUrl,
        hosting_provider: environment.hostingProvider,
        stack: environment.stack,
        versions: environment.versions,
        runtime: environment.runtime ?? null,
        // Legacy columns stay populated so anything still reading them is truthful.
        wordpress_version: environment.versions.wordpress ?? "",
        php_version: environment.versions.php ?? "",
        cache_layers: environment.cacheLayers,
        notes: environment.notes,
      })) as never));
    }

    if (newProject.accessMethods.length > 0) {
      await insertRows(client.from("project_access_methods").insert(newProject.accessMethods.map((access) => ({
        id: crypto.randomUUID(),
        project_id: projectId,
        environment_id: firstEnvironmentId,
        access_type: access.type,
        label: access.label,
        status: access.status,
        auth_method: access.authMethod,
        last_verified_at: access.lastVerifiedAt,
        notes: access.notes,
      })) as never));
    }

    if (newProject.memoryEntries.length > 0) {
      await insertRows(client.from("project_memory_entries").insert(newProject.memoryEntries.map((entry) => ({
        id: crypto.randomUUID(),
        project_id: projectId,
        environment_id: firstEnvironmentId,
        memory_type: entry.type,
        importance: entry.importance,
        title: entry.title,
        content: entry.content,
      })) as never));
    }

    if (newProject.qaRules.length > 0) {
      await insertRows(client.from("qa_rules").insert(newProject.qaRules.map((rule) => ({
        id: crypto.randomUUID(),
        project_id: projectId,
        environment_id: firstEnvironmentId,
        name: rule.name,
        rule_type: rule.type,
        required: rule.required,
        description: rule.description,
      })) as never));
    }

    if (newProject.recommendations.length > 0) {
      await insertRows(client.from("project_recommendations").insert(newProject.recommendations.map((recommendation) => ({
        id: crypto.randomUUID(),
        project_id: projectId,
        category: recommendation.category,
        priority: recommendation.priority,
        status: recommendation.status,
        title: recommendation.title,
        summary: recommendation.summary,
      })) as never));
    }

    return this.loadWorkspace();
  }

  async getProject(projectId: string): Promise<Project | null> {
    const workspace = await this.loadWorkspace();
    return getProjectById(workspace, projectId);
  }

  async getActiveRun(projectId: string): Promise<Run | null> {
    const project = await this.getProject(projectId);
    return getActiveRun(project);
  }

  async advanceRun(projectId: string, runId: string, targetState: Run["state"]): Promise<Organization> {
    const workspace = await this.loadWorkspace();
    const { run } = findRun(workspace, projectId, runId);
    if (!run) return workspace;

    const updatedRun = advanceRunState(run, targetState);
    const client = getSupabaseClient();

    await (client.from("runs") as never as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({
      state: updatedRun.state,
      updated_at: updatedRun.updatedAt,
      next_action: updatedRun.nextAction,
    }).eq("id", runId);

    await Promise.all(updatedRun.phases.map((phase) =>
      (client.from("run_phases") as never as { update: (v: unknown) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => unknown } } }).update({ status: phase.status })
        .eq("run_id", runId).eq("state", phase.state),
    ));

    // Learning loop: when a task reaches complete, record the resolution
    // pattern in the knowledge base so future runs benefit from it.
    // Fire-and-forget — never blocks the UI or throws.
    if (targetState === "complete" && updatedRun.taskType) {
      // Resolve the hosting provider for this project's environment.
      let hostContext: string | null = null;
      try {
        const envRow = await client
          .from("project_environments")
          .select("hosting_provider")
          .eq("project_id", projectId)
          .maybeSingle();
        hostContext = (envRow.data as { hosting_provider?: string } | null)?.hosting_provider ?? null;
      } catch { /* non-fatal */ }

      executionGateway().recordResolution({
        projectId,
        runId,
        taskType: updatedRun.taskType,
        taskTitle: updatedRun.title ?? "",
        hostContext,
      }).catch(() => { /* fire and forget */ });
    }

    return this.loadWorkspace();
  }

  async confirmBackup(_projectId: string, runId: string, note: string): Promise<Organization> {
    const client = getSupabaseClient();

    await (client.from("runs") as never as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({
      backup_status: "confirmed_by_operator",
      updated_at: new Date().toISOString(),
    }).eq("id", runId);

    await client.from("run_artifacts").insert([{
      id: crypto.randomUUID(),
      run_id: runId,
      artifact_type: "backup_note",
      title: "Backup confirmed",
      summary: note,
    }] as never);

    return this.loadWorkspace();
  }

  async approveRun(_projectId: string, runId: string, approvalType: "high_risk_execution" | "qa_waiver" | "rollback", decision: "approved" | "rejected", reason: string): Promise<Organization> {
    const client = getSupabaseClient();
    const id = crypto.randomUUID();

    await client.from("run_approvals").insert([{
      id,
      run_id: runId,
      approval_type: approvalType,
      status: decision,
      reason,
      decided_at: new Date().toISOString(),
    }] as never);

    if (approvalType === "high_risk_execution" && decision === "approved") {
      await (client.from("runs") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({ approval_required: false, updated_at: new Date().toISOString() }).eq("id", runId);
    }

    return this.loadWorkspace();
  }

  async rollbackRun(_projectId: string, runId: string, reason: string): Promise<Organization> {
    const client = getSupabaseClient();
    const now = new Date().toISOString();

    await (client.from("runs") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({
      state: "rolled_back",
      updated_at: now,
    }).eq("id", runId);

    await client.from("run_findings").insert([{
      id: crypto.randomUUID(),
      run_id: runId,
      severity: "high",
      title: "Rollback executed",
      summary: reason,
    }] as never);

    await client.from("run_actions").insert([{
      id: crypto.randomUUID(),
      run_id: runId,
      actor: "operator",
      summary: `Rolled back: ${reason}`,
      outcome: "succeeded",
    }] as never);

    return this.loadWorkspace();
  }

  async closeRunManually(_projectId: string, runId: string, note: string): Promise<Organization> {
    const client = getSupabaseClient();
    const now = new Date().toISOString();

    await (client.from("runs") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({
      state: "complete",
      next_action: "Closed by the operator. Nothing further is queued.",
      completed_at: now,
      updated_at: now,
    }).eq("id", runId);

    await (client.from("run_phases") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } })
      .update({ status: "completed" }).eq("run_id", runId);

    await client.from("run_actions").insert([{
      id: crypto.randomUUID(),
      run_id: runId,
      actor: "operator",
      summary: note,
      outcome: "succeeded",
    }] as never);

    return this.loadWorkspace();
  }

  async promoteQueuedRun(projectId: string, runId: string): Promise<Organization> {
    const client = getSupabaseClient();
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const target = project.runs.find((run) => run.id === runId);
    if (!target || !isQueuedRun(target)) return workspace;

    const live = getActiveRun(project);
    const now = new Date().toISOString();
    const runs = client.from("runs") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => PromiseLike<unknown> } };

    if (live && live.state !== "complete") {
      // Park the live task at the front of the queue so nothing is lost.
      await runs.update({ queue_position: -1, updated_at: now }).eq("id", live.id);
    }

    await runs.update({ queue_position: null, updated_at: now }).eq("id", runId);
    return this.loadWorkspace();
  }

  async moveQueuedRun(projectId: string, runId: string, direction: "up" | "down"): Promise<Organization> {
    const client = getSupabaseClient();
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const queue = getQueuedRuns(project);
    const index = queue.findIndex((run) => run.id === runId);
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (index === -1 || swapWith < 0 || swapWith >= queue.length) return workspace;

    const reordered = queue.slice();
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
    const runs = client.from("runs") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => PromiseLike<unknown> } };

    await Promise.all(reordered.map((run, order) => runs.update({ queue_position: order }).eq("id", run.id)));
    return this.loadWorkspace();
  }

  async cancelQueuedRun(projectId: string, runId: string): Promise<Organization> {
    const client = getSupabaseClient();
    const workspace = await this.loadWorkspace();
    const project = getProjectById(workspace, projectId);
    if (!project) return workspace;

    const target = project.runs.find((run) => run.id === runId);
    if (!target || !isQueuedRun(target)) return workspace;

    const now = new Date().toISOString();
    // The task never ran, so it is closed rather than deleted: the brief that
    // created it stays in the conversation.
    await (client.from("runs") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => PromiseLike<unknown> } }).update({
      state: "complete",
      queue_position: null,
      next_action: "Removed from the queue before it started.",
      completed_at: now,
      updated_at: now,
    }).eq("id", runId);

    await (client.from("run_phases") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => PromiseLike<unknown> } })
      .update({ status: "completed" }).eq("run_id", runId);

    await client.from("run_actions").insert([{
      id: crypto.randomUUID(),
      run_id: runId,
      actor: "operator",
      summary: "Removed from the queue before it started.",
      outcome: "succeeded",
    }] as never);

    return this.loadWorkspace();
  }


  async updateQaResult(_projectId: string, _runId: string, resultId: string, result: "passed" | "failed" | "warning" | "skipped", notes: string): Promise<Organization> {
    const client = getSupabaseClient();
    await (client.from("qa_results") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({ result, notes } as unknown).eq("id", resultId);
    return this.loadWorkspace();
  }

  async setQaVerdict(_projectId: string, runId: string, verdict: "passed" | "failed" | "partial" | "waived", summary: string): Promise<Organization> {
    const client = getSupabaseClient();
    await (client.from("qa_reports") as unknown as { update: (v: unknown) => { eq: (k: string, v: string) => unknown } }).update({
      verdict,
      summary,
      updated_at: new Date().toISOString(),
    } as unknown).eq("run_id", runId);
    return this.loadWorkspace();
  }

  async getRecentEvidence(_projectId: string, runId: string, artifactType: string, limit: number): Promise<Array<{ summary: string }>> {
    try {
      const client = getSupabaseClient();
      const { data } = await client
        .from("run_artifacts")
        .select("summary")
        .eq("run_id", runId)
        .eq("artifact_type", artifactType)
        .order("created_at", { ascending: false })
        .limit(limit);
      return (data ?? []) as Array<{ summary: string }>;
    } catch {
      return [];
    }
  }

  async addEvidence(_projectId: string, runId: string, artifactType: "backup_note" | "scan_result" | "diff_summary" | "qa_capture" | "report" | "fix_plan" | "execution_failed", title: string, summary: string): Promise<Organization> {
    const client = getSupabaseClient();
    await client.from("run_artifacts").insert([{
      id: crypto.randomUUID(),
      run_id: runId,
      artifact_type: artifactType,
      title,
      summary,
    }] as never);
    return this.loadWorkspace();
  }

  async addRecommendation(projectId: string, runId: string | null, category: Recommendation["category"], priority: Recommendation["priority"], title: string, summary: string): Promise<Organization> {
    const client = getSupabaseClient();
    const id = crypto.randomUUID();

    if (runId) {
      await client.from("run_recommendations").insert([{
        id, run_id: runId, category, priority, status: "open", title, summary,
      }] as never);
    } else {
      await client.from("project_recommendations").insert([{
        id, project_id: projectId, category, priority, status: "open", title, summary,
      }] as never);
    }
    return this.loadWorkspace();
  }

  async addMemoryEntry(projectId: string, entry: { title: string; type: MemoryEntry["type"]; importance: MemoryEntry["importance"]; content: string; sourceRunId?: string | null; sourceMessageId?: string | null }): Promise<Organization> {
    const client = getSupabaseClient();
    await client.from("project_memory_entries").insert([{
      id: crypto.randomUUID(),
      project_id: projectId,
      memory_type: entry.type,
      importance: entry.importance,
      title: entry.title,
      content: entry.content,
      ...(entry.sourceRunId ? { source_run_id: entry.sourceRunId } : {}),
      ...(entry.sourceMessageId ? { source_message_id: entry.sourceMessageId } : {}),
    }] as never);
    return this.loadWorkspace();
  }

  async saveAccessMethod(projectId: string, method: ProjectAccessMethod): Promise<Organization> {
    const client = getSupabaseClient();
    const { error } = await (client.from("project_access_methods") as never as {
      upsert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    }).upsert([{
      // The column is a uuid. A friendly-looking id would be rejected, so any
      // non-uuid id is replaced before the write instead of failing silently.
      id: isUuid(method.id) ? method.id : crypto.randomUUID(),
      project_id: projectId,
      access_type: method.type,
      label: method.label,
      status: method.status,
      auth_method: method.authMethod,
      last_verified_at: method.lastVerifiedAt || null,
      notes: method.notes,
      // A reference, never a value. The secret lives in the server-only store.
      credential_reference: method.credentialReference ?? null,
    }]);
    // A rejected write must be heard. Reporting success here is what made a
    // saved connection reappear as "Not connected".
    if (error) throw new Error(error.message);
    return this.loadWorkspace();
  }

  async removeAccessMethod(_projectId: string, methodId: string): Promise<Organization> {
    const client = getSupabaseClient();
    await (client.from("project_access_methods") as never as {
      delete: () => { eq: (k: string, v: string) => Promise<unknown> };
    }).delete().eq("id", methodId);
    return this.loadWorkspace();
  }

  async verifyAccessMethod(_projectId: string, methodId: string, accessType?: AccessType): Promise<Organization> {
    // An executable credential is proven by the server or not at all. This
    // path must never stamp a verification time for one, even if asked: the
    // database guard would refuse the write anyway, and pretending here would
    // be worse than refusing.
    if (accessType === "wordpress_admin") return this.loadWorkspace();

    const client = getSupabaseClient();
    await (client.from("project_access_methods") as never as {
      update: (v: unknown) => { eq: (k: string, v: string) => Promise<unknown> };
    }).update({ status: "available", last_verified_at: new Date().toISOString() }).eq("id", methodId);
    return this.loadWorkspace();
  }

  async applyServerVerification(): Promise<Organization> {
    // Native path. The `access-secrets` function already wrote the outcome
    // under its own privileges, and the database guard would refuse a write
    // from here anyway. Re-reading is the only honest reconciliation.
    return this.loadWorkspace();
  }

  async listProjectMessages(projectId: string): Promise<ProjectMessage[]> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("project_messages")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    return sortByCreatedAt(((data ?? []) as ProjectMessageRow[]).map(mapProjectMessage));
  }

  async listRunMessages(projectId: string, runId: string): Promise<ProjectMessage[]> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("project_messages")
      .select("*")
      .eq("project_id", projectId)
      .eq("run_id", runId)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    return sortByCreatedAt(((data ?? []) as ProjectMessageRow[]).map(mapProjectMessage));
  }

  async addProjectMessage(projectId: string, message: NewProjectMessage): Promise<ProjectMessage> {
    // Same guard on the persisted path. Redaction is defence in depth, not
    // the storage mechanism: real credentials go to the intake function.
    message = { ...message, body: redactBody(message.body) };
    const client = getSupabaseClient();
    const dedupeKey = message.dedupeKey ?? null;

    if (dedupeKey) {
      const { data: existing } = await client
        .from("project_messages")
        .select("*")
        .eq("project_id", projectId)
        .eq("dedupe_key", dedupeKey)
        .limit(1);

      const match = ((existing ?? []) as ProjectMessageRow[])[0];
      if (match) {
        return mapProjectMessage(match);
      }
    }

    const row: ProjectMessageRow = {
      id: createMessageId(),
      project_id: projectId,
      run_id: message.runId ?? null,
      role: message.role,
      kind: message.kind,
      body: message.body,
      dedupe_key: dedupeKey,
      source_key: message.sourceKey ?? null,
      created_at: new Date().toISOString(),
    };

    let { error } = await client.from("project_messages").insert([row] as never);

    if (error) {
      // A concurrent writer may have already stored the same deterministic
      // message. Prefer the stored record over failing the conversation.
      if (dedupeKey) {
        const { data: retry } = await client
          .from("project_messages")
          .select("*")
          .eq("project_id", projectId)
          .eq("dedupe_key", dedupeKey)
          .limit(1);
        const match = ((retry ?? []) as ProjectMessageRow[])[0];
        if (match) return mapProjectMessage(match);

        // The unique index is the final authority for idempotency. A row can
        // legitimately be hidden from this immediate SELECT while the browser
        // session or replica catches up, but 23505 proves the same logical
        // message is already durable. Treat that as success rather than
        // retrying an INSERT that can only fail again.
        if (error.code === "23505" || /project_messages_dedupe_idx|duplicate key/i.test(error.message ?? "")) {
          return mapProjectMessage(row);
        }
      }
      // A stale access token or a dropped connection must not lose what the
      // person just said. Refresh once and try the same row again.
      const transient =
        !error.code ||
        error.code === "PGRST301" ||
        error.code === "401" ||
        /jwt|token|fetch|network|timeout/i.test(`${error.message ?? ""}`);
      if (transient) {
        try {
          await client.auth.refreshSession();
        } catch {
          /* keep the original failure if the refresh itself fails */
        }
        const second = await client.from("project_messages").insert([row] as never);
        error = second.error;
      }
      if (error) throw error;
    }

    return mapProjectMessage(row);
  }

  private mapExecutionRow(row: Record<string, unknown>): ExecutionEvent {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      runId: (row.run_id as string | null) ?? null,
      toolId: row.tool_id as ExecutionEvent["toolId"],
      invocationKey: String(row.invocation_key),
      status: row.status as ExecutionEvent["status"],
      risk: row.risk as ExecutionEvent["risk"],
      startedAt: String(row.started_at),
      finishedAt: (row.finished_at as string | null) ?? null,
      inputSummary: String(row.input_summary ?? ""),
      outputSummary: String(row.output_summary ?? ""),
      errorCode: (row.error_code as ExecutionEvent["errorCode"]) ?? null,
      evidenceRefs: (row.evidence_refs as string[] | null) ?? [],
      evidenceData: (row.evidence_data as Record<string, unknown> | null) ?? null,
    };
  }

  async listExecutionEvents(projectId: string, runId?: string): Promise<ExecutionEvent[]> {
    const client = getSupabaseClient();
    let query = client
      .from("agent_execution_events")
      .select("*")
      .eq("project_id", projectId)
      .order("started_at", { ascending: true });
    if (runId) query = query.eq("run_id", runId);
    const { data, error } = await query;
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((row) => this.mapExecutionRow(row));
  }

  async findExecutionEvent(projectId: string, invocationKey: string): Promise<ExecutionEvent | null> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("agent_execution_events")
      .select("*")
      .eq("project_id", projectId)
      .eq("invocation_key", invocationKey)
      .limit(1);
    if (error) throw error;
    const row = ((data ?? []) as Record<string, unknown>[])[0];
    return row ? this.mapExecutionRow(row) : null;
  }

  async saveExecutionEvent(projectId: string, event: NewExecutionEvent): Promise<ExecutionEvent> {
    const client = getSupabaseClient();
    const existing = await this.findExecutionEvent(projectId, event.invocationKey);
    const row = {
      id: existing?.id ?? createMessageId(),
      project_id: projectId,
      run_id: event.runId,
      tool_id: event.toolId,
      invocation_key: event.invocationKey,
      status: event.status,
      risk: event.risk,
      started_at: event.startedAt,
      finished_at: event.finishedAt,
      input_summary: event.inputSummary,
      output_summary: event.outputSummary,
      error_code: event.errorCode,
      evidence_refs: event.evidenceRefs,
      evidence_data: event.evidenceData ?? null,
    };
    const { error } = await client
      .from("agent_execution_events")
      .upsert([row] as never, { onConflict: "project_id,invocation_key" } as never);
    if (error) throw error;
    return { ...event, id: row.id, projectId };
  }

  async loadRunPlan(projectId: string, runId: string): Promise<RunPlan | null> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("run_plans")
      .select("*")
      .eq("project_id", projectId)
      .eq("run_id", runId)
      .limit(1);
    if (error) throw error;
    const row = ((data ?? []) as Record<string, unknown>[])[0];
    if (!row) return null;
    return {
      projectId,
      runId,
      goal: String(row.goal ?? ""),
      hypotheses: (row.hypotheses ?? []) as RunPlan["hypotheses"],
      steps: (row.steps ?? []) as RunPlan["steps"],
      revision: Number(row.revision ?? 0),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    };
  }

  async saveRunPlan(plan: RunPlan): Promise<RunPlan> {
    const client = getSupabaseClient();
    const row = {
      project_id: plan.projectId,
      run_id: plan.runId,
      goal: plan.goal,
      hypotheses: plan.hypotheses,
      steps: plan.steps,
      revision: plan.revision,
    };
    const { error } = await client
      .from("run_plans")
      .upsert([row] as never, { onConflict: "run_id" } as never);
    if (error) throw error;
    return { ...plan, updatedAt: new Date().toISOString() };
  }

  /**
   * The knowledge base is service-role only (RLS without anon policies), so
   * the browser never touches the table directly. Reads route through the
   * authorized agent-execute boundary, which proves project ownership first.
   */
  async listKnowledgeBase(projectId: string, taskType?: string): Promise<KBEntry[]> {
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-execute", {
        body: {
          mode: "kb_list",
          projectId,
          args: taskType ? { taskType } : {},
        },
      });
      if (error) return [];
      const payload = data as { ok?: boolean; data?: { entries?: unknown[] } } | null;
      if (!payload?.ok || !Array.isArray(payload.data?.entries)) return [];
      return payload.data!.entries
        .map((row): KBEntry | null => {
          const record = row as Record<string, unknown>;
          if (!record || typeof record !== "object") return null;
          const strings = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
          return {
            id: String(record.id ?? ""),
            scope: String(record.scope ?? "global"),
            taskType: String(record.task_type ?? ""),
            symptomPattern: String(record.symptom_pattern ?? ""),
            resolution: String(record.resolution ?? ""),
            evidenceSignals: strings(record.evidence_signals),
            toolsUsed: strings(record.tools_used),
            hostContext: typeof record.host_context === "string" ? record.host_context : null,
            projectCount: Number(record.project_count ?? 1),
            lastConfirmedAt: String(record.last_confirmed_at ?? ""),
            createdAt: String(record.created_at ?? ""),
            updatedAt: String(record.updated_at ?? ""),
          };
        })
        .filter((entry): entry is KBEntry => entry !== null);
    } catch {
      // The library is an enhancement. Unreachable means empty, never a crash.
      return [];
    }
  }

  async upsertKnowledgeBaseEntry(projectId: string, entry: {
    taskType: string;
    symptomPattern: string;
    resolution: string;
    evidenceSignals: string[];
    toolsUsed: string[];
    hostContext?: string | null;
  }): Promise<void> {
    try {
      const client = getSupabaseClient();
      await client.functions.invoke("agent-execute", {
        body: {
          mode: "kb_upsert",
          projectId,
          args: {
            taskType: entry.taskType,
            symptomPattern: entry.symptomPattern,
            resolution: entry.resolution,
            evidenceSignals: entry.evidenceSignals,
            toolsUsed: entry.toolsUsed,
            hostContext: entry.hostContext ?? null,
          },
        },
      });
    } catch {
      // A failed KB write must never break a run.
    }
  }

  private async selectIn<TRow>(
    table: string,
    column: string,
    ids: string[],
    orderBy?: string,
    ascending = true,
  ): Promise<TRow[]> {
    const client = getSupabaseClient();
    let query = client.from(table).select("*").in(column, ids);

    if (orderBy) {
      query = query.order(orderBy, { ascending });
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return (data ?? []) as TRow[];
  }
}

function mapEnvironment(row: ProjectEnvironmentRow): ProjectEnvironment {
  // Legacy rows carry only wordpress/php columns and no stack. They stay valid.
  const versions = normalizeVersions({
    versions: row.versions ?? undefined,
    wordpressVersion: row.wordpress_version,
    phpVersion: row.php_version,
  });

  return {
    id: row.id,
    name: row.name,
    type: row.environment_type,
    primaryUrl: row.primary_url,
    hostingProvider: row.hosting_provider,
    stack: isProjectStack(row.stack) ? (row.stack as ProjectEnvironment["stack"]) : "wordpress",
    versions,
    runtime: row.runtime ?? undefined,
    wordpressVersion: row.wordpress_version ?? undefined,
    phpVersion: row.php_version ?? undefined,
    cacheLayers: row.cache_layers ?? [],
    notes: row.notes,
  };
}

function mapAccessMethod(row: ProjectAccessMethodRow): ProjectAccessMethod {
  return {
    id: row.id,
    type: row.access_type,
    label: row.label,
    status: row.status,
    authMethod: row.auth_method,
    lastVerifiedAt: row.last_verified_at ?? "Unknown",
    notes: row.notes,
    ...(row.credential_reference ? { credentialReference: row.credential_reference } : {}),
  };
}

function mapMemoryEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    title: row.title,
    type: row.memory_type,
    importance: row.importance,
    content: row.content,
    sourceRunId: row.source_run_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
  };
}

function mapProjectMessage(row: ProjectMessageRow): ProjectMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    role: row.role,
    kind: row.kind,
    body: row.body ?? [],
    createdAt: row.created_at,
    dedupeKey: row.dedupe_key ?? null,
    sourceKey: row.source_key ?? null,
  };
}

function sortByCreatedAt(messages: ProjectMessage[]): ProjectMessage[] {
  return [...messages].sort((a, b) => {
    const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mapQaRule(row: QaRuleRow): QaRule {
  return {
    id: row.id,
    name: row.name,
    type: row.rule_type,
    required: row.required,
    description: row.description,
  };
}

function mapRiskFlag(row: RiskFlagRow): RiskFlag {
  return {
    id: row.id,
    severity: row.severity,
    status: row.status,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    category: row.category,
    priority: row.priority,
    status: row.status,
    title: row.title,
    summary: row.summary,
  };
}

function mapRun(
  run: RunRow,
  related: {
    phaseRows: RunPhaseRow[];
    findingRows: RunFindingRow[];
    actionRows: RunActionRow[];
    artifactRows: RunArtifactRow[];
    approvalRows: RunApprovalRow[];
    qaReportRows: QaReportRow[];
    qaResultRows: QaResultRow[];
    runRecommendationRows: RecommendationRow[];
  },
): Run {
  const qaReport = related.qaReportRows.find((report) => report.run_id === run.id);
  const qaResults = qaReport
    ? related.qaResultRows
        .filter((result) => result.qa_report_id === qaReport.id)
        .map((result) => ({
          id: result.id,
          name: result.name,
          result: result.result,
          notes: result.notes,
        }))
    : [];

  return {
    id: run.id,
    title: run.title,
    taskType: run.task_type,
    taskSummary: run.task_summary,
    urgency: run.urgency,
    environmentId: run.environment_id,
    state: run.state,
    riskLevel: run.risk_level,
    backupStatus: run.backup_status,
    approvalRequired: run.approval_required,
    nextAction: run.next_action,
    operatorPrompt: run.operator_prompt,
    diagnosisSummary: run.diagnosis_summary,
    planSummary: run.plan_summary,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    queuePosition: run.queue_position ?? null,

    phases: related.phaseRows
      .filter((phase) => phase.run_id === run.id)
      .map((phase) => ({
        id: phase.id,
        state: phase.state,
        label: phase.label,
        summary: phase.summary,
        status: phase.status,
      })),
    findings: related.findingRows
      .filter((finding) => finding.run_id === run.id)
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
      })),
    actions: related.actionRows
      .filter((action) => action.run_id === run.id)
      .map((action) => ({
        id: action.id,
        actor: action.actor,
        summary: action.summary,
        outcome: action.outcome,
      })),
    artifacts: related.artifactRows
      .filter((artifact) => artifact.run_id === run.id)
      .map((artifact) => ({
        id: artifact.id,
        type: artifact.artifact_type,
        title: artifact.title,
        summary: artifact.summary,
      })),
    approvals: related.approvalRows
      .filter((approval) => approval.run_id === run.id)
      .map((approval) => ({
        id: approval.id,
        type: approval.approval_type,
        status: approval.status,
        reason: approval.reason,
      })),
    qaReport: {
      verdict: qaReport?.verdict ?? "partial",
      summary: qaReport?.summary ?? "QA report not found for this run yet.",
      unresolvedRisks: qaReport?.unresolved_risks ?? [],
      results: qaResults,
    },
    recommendations: related.runRecommendationRows
      .filter((recommendation) => recommendation.run_id === run.id)
      .map(mapRecommendation),
  };
}

/** The next free slot at the back of a project's queue. */
function nextQueuePosition(project: Project): number {
  const queued = getQueuedRuns(project);
  return queued.length === 0 ? 0 : (queued[queued.length - 1].queuePosition ?? 0) + 1;
}

function injectRunIntoWorkspace(workspace: Organization, projectId: string, newRun: Run): Organization {
  return {
    ...workspace,
    projects: workspace.projects.map((candidate) =>
      candidate.id !== projectId
        ? candidate
        : {
            ...candidate,
            runs: [newRun, ...candidate.runs],
          },
    ),
  };
}

async function insertRows(
  operation: PromiseLike<{ error: PostgrestError | null }>,
): Promise<void> {
  const result = await operation;

  if (result.error) {
    throw result.error;
  }
}

function summarizeSupabaseError(error: PostgrestError): string {
  return `Supabase error: ${error.message}`;
}

function createWorkspaceRepository(): WorkspaceRepository {
  const env = resolveOpsEnv();

  // Local (demo) persistence is only ever reachable through an explicit,
  // non-production demo opt-in. Without it, a missing Supabase config is a
  // configuration error the app must surface — never quietly-fake data.
  if (isDemoModeAllowed(env)) {
    return new LocalWorkspaceRepository();
  }

  if (!hasSupabasePublicConfig(env)) {
    if (env.isProductionBuild) {
      return new SupabaseWorkspaceRepository();
    }

    return new LocalWorkspaceRepository();
  }

  return new SupabaseWorkspaceRepository();
}

export const workspaceRepository: WorkspaceRepository = createWorkspaceRepository();

function findRun(workspace: Organization, projectId: string, runId: string): { project: Project | null; run: Run | null } {
  const project = getProjectById(workspace, projectId);
  if (!project) return { project: null, run: null };
  const run = project.runs.find((r) => r.id === runId) ?? null;
  return { project, run };
}

function replaceRun(workspace: Organization, projectId: string, updatedRun: Run): Organization {
  return {
    ...workspace,
    projects: workspace.projects.map((p) =>
      p.id !== projectId ? p : {
        ...p,
        runs: p.runs.map((r) => r.id === updatedRun.id ? updatedRun : r),
      },
    ),
  };
}
