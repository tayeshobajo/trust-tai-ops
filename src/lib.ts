import type { Organization, Project, ProjectDraft, ProjectEnvironment, ProjectAccessMethod, Run, RunDraft, RunPhase, RunState } from "./types";
import { createPhases } from "./data";
import { accessTypeLabels, getProjectStack, stackCopy } from "./stacks";

export const getProjectById = (workspace: Organization, projectId: string | null): Project | null =>
  workspace.projects.find((project) => project.id === projectId) ?? null;

export const isRunStale = (run: Pick<Run, "updatedAt"> | null, maxAgeMs: number): boolean => {
  if (!run) return false;
  const updatedAt = new Date(run.updatedAt).getTime();
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > maxAgeMs;
};

/** A task waiting its turn. The agent never works on one of these. */
export const isQueuedRun = (run: Run): boolean => (run.queuePosition ?? null) !== null;

/** States where a task is parked on a human and cannot progress by itself. */
const PARKED_STATES: RunState[] = ["paused", "escalated", "failed", "rolled_back"];

export const getActiveRun = (project: Project | null): Run | null => {
  if (!project) {
    return null;
  }

  const live = project.runs.filter((run) => !isQueuedRun(run));
  const open = live.filter((run) => run.state !== "complete");
  // A task stuck on a human decision must not hold the workspace hostage: if
  // something else can actually move, that becomes the live task.
  const movable = open.find((run) => !PARKED_STATES.includes(run.state));
  return movable ?? open[0] ?? live[0] ?? null;
};

/** Waiting tasks, in the order they will be started. */
export const getQueuedRuns = (project: Project | null): Run[] => {
  if (!project) return [];
  return project.runs
    .filter(isQueuedRun)
    .slice()
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
};


export const getEnvironmentName = (project: Project | null, environmentId: string) =>
  project?.environments.find((environment) => environment.id === environmentId)?.name ?? "Environment";

export const getRunPhases = (run: Run): RunPhase[] =>
  run.phases.length > 0 ? run.phases : createPhases(run.state, run.taskType);

export const getRunProgress = (run: Run) => {
  const phases = getRunPhases(run);
  const activeIndex = phases.findIndex((phase) => phase.status === "active");
  const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(phases.findIndex((phase) => phase.state === run.state), 0);
  const currentPhase = phases[currentIndex] ?? phases[0];
  const nextPhase = phases[currentIndex + 1] ?? null;
  const completedCount = phases.filter((phase) => phase.status === "completed").length;
  const weightedProgress = run.state === "complete"
    ? phases.length
    : Math.min(phases.length, completedCount + (currentPhase ? 0.58 : 0));

  return {
    phases,
    currentPhase,
    nextPhase,
    progressPercent: Math.round((weightedProgress / phases.length) * 100),
  };
};

/**
 * A release is not an investigation. The states are identical; only the words
 * a person reads change, in step with the deploy phase labels.
 */
const deployNarrative: Partial<Record<RunState, { now: string; next: string }>> = {
  environment_mapping: {
    now: "Checking the pipeline: which branch the work sits on, and whether staging is current.",
    next: "Once the branch state is clear, staging gets verified before anything ships.",
  },
  diagnosis: {
    now: "Pre-deploy verification: confirming staging is live and the tests pass.",
    next: "If staging holds up, the release can be merged and watched through CI.",
  },
  execution: {
    now: "Running the deploy: merging, watching CI, and confirming the service comes back healthy.",
    next: "After the deploy lands, production gets a health check before anyone calls it done.",
  },
  qa: {
    now: "Post-deploy health check: the production URL, the process status, and the error rate.",
    next: "If production is healthy, the release closes with recommendations and updated memory.",
  },
};

export const getRunStateNarrative = (run: Run) => {
  const deployCopy = run.taskType === "deploy" ? deployNarrative[run.state] : undefined;
  if (deployCopy) return deployCopy;

  switch (run.state) {
    case "access_check":
      return {
        now: "Validating which doors are truly open for this environment.",
        next: "Once access truth is clear, the agent can map the environment safely.",
      };
    case "backup_gate":
      return {
        now: "Holding the run at the restore-readiness gate before anything write-capable begins.",
        next: "After backup proof is in hand, the system can move into environment mapping.",
      };
    case "environment_mapping":
      return {
        now: "Loading stack truth, access truth, and project memory before forming conclusions.",
        next: "The next lawful move is turning those findings into a diagnosis artifact.",
      };
    case "diagnosis":
      return {
        now: "Narrowing the root cause into something the team can trust.",
        next: "Once the cause is named clearly, the run can shape a bounded plan.",
      };
    case "plan":
      return {
        now: "Constraining the fix path and checking whether approval is required.",
        next: "If the plan is accepted, the run moves into tightly logged execution.",
      };
    case "execution":
      return {
        now: "Applying the smallest safe change path and watching for blast-radius drift.",
        next: "After execution, QA proves whether the result is real.",
      };
    case "qa":
      return {
        now: "Running final checks and closing the gap between ‘changed’ and ‘safe to trust’.",
        next: "If QA passes, the run turns into recommendations and updated memory.",
      };
    case "recommendations":
      return {
        now: "Turning this run into durable project wisdom and clear follow-up actions.",
        next: "Once recommendations are captured, the run can close cleanly.",
      };
    case "complete":
      return {
        now: "The run is closed with proof, summary, and next actions already captured.",
        next: "No action is needed unless a follow-up run should be created.",
      };
    case "paused":
      return {
        now: "The run is paused on purpose until a prerequisite or approval arrives.",
        next: "Once the blocker clears, it can resume from the last lawful state.",
      };
    case "escalated":
      return {
        now: "The system found a condition that exceeds safe autonomous handling.",
        next: "A senior operator should decide whether to widen scope, change plan, or hand off.",
      };
    case "failed":
      return {
        now: "The current path could not finish safely and needs a new decision.",
        next: "The follow-up should start from the structured failure summary, not from memory.",
      };
    case "rolled_back":
      return {
        now: "The run reversed course to restore stability or reduce risk.",
        next: "Post-rollback verification decides whether the run can resume or should escalate.",
      };
    case "intake":
    default:
      return {
        now: "Shaping the request into a structured run the system can operate inside.",
        next: "The next move is validating access and environment certainty.",
      };
  }
};

export const countOpenRisks = (project: Project) =>
  project.riskFlags.filter((flag) => flag.status === "open" || flag.status === "monitoring").length;

export const countOpenRecommendations = (project: Project) =>
  project.recommendations.filter((item) => item.status === "open" || item.status === "accepted").length +
  project.runs.flatMap((run) => run.recommendations).filter((item) => item.status === "open" || item.status === "accepted").length;

export const taskTypeToTitle = (taskType: Run["taskType"]) => {
  switch (taskType) {
    case "malware":
      return "Malware";
    case "performance":
      return "Performance";
    case "broken_site":
      return "Broken Site";
    case "plugin_theme_conflict":
      return "Plugin / Theme Conflict";
    case "hardening":
      return "Hardening";
    case "qa_only":
      return "QA";
    case "deploy":
      return "Deploy";
    case "migration":
      return "Migration";
    case "feature":
      return "Feature";
    case "dependency_upgrade":
      return "Dependency Upgrade";
    default:
      return "Run";
  }
};

export const isReadOnlyRunDraft = (draft: RunDraft) => draft.taskType === "qa_only";

export const getRunEntryState = (draft: RunDraft): RunState => {
  if (!draft.accessReady) {
    return "access_check";
  }

  if (isReadOnlyRunDraft(draft)) {
    return "environment_mapping";
  }

  return draft.backupConfirmed ? "environment_mapping" : "backup_gate";
};

export const getRunSystemReaction = (draft: RunDraft) => {
  if (!draft.accessReady) {
    return "This run will open in Access Check because the system should not guess about available doors.";
  }

  if (isReadOnlyRunDraft(draft)) {
    return "This run will open in Environment Mapping as a read-only verification pass, so the agent can inspect before any risky work exists.";
  }

  return draft.backupConfirmed
    ? "This run will open in Environment Mapping so the agent can gather evidence before diagnosis."
    : "This run will stop at Backup Gate until restore readiness is confirmed.";
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const normalizeDomain = (websiteUrl: string) => {
  try {
    const url = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return websiteUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
};

export const createProjectFromDraft = (draft: ProjectDraft): Project => {
  const baseId = slugify(draft.name || draft.clientName || draft.websiteUrl || `project-${Date.now()}`) || `project-${Date.now()}`;
  const primaryDomain = normalizeDomain(draft.websiteUrl);
  const environmentId = `${baseId}-production`;
  const accessMethods: ProjectAccessMethod[] = draft.accessSelections
    .filter((selection) => selection.enabled)
    .map((selection) => ({
      id: `${baseId}-${selection.type}`,
      type: selection.type,
      label: accessTypeLabels[selection.type] ?? "Hosting / Other",
      status: "available",
      authMethod: "Pending secure credential handoff",
      // Selecting a card records an intention, not a verified connection.
      lastVerifiedAt: "",
      notes: "Access path added during project creation. Verification should happen during the first real run.",
    }));

  const environments: ProjectEnvironment[] = draft.createProductionEnvironment
    ? [{
        id: environmentId,
        name: "Production",
        type: "production",
        primaryUrl: draft.websiteUrl.startsWith("http") ? draft.websiteUrl : `https://${draft.websiteUrl}`,
        hostingProvider: draft.hostingProvider.trim() || "Hosting not recorded yet",
        stack: draft.stack,
        versions: Object.fromEntries(
          Object.entries(draft.versions ?? {})
            .map(([key, value]) => [key, value.trim()])
            .filter(([, value]) => Boolean(value)),
        ),
        cacheLayers: [],
        notes: draft.description.trim() || "Fresh project. Environment mapping will fill in the sharper truths once access is verified.",
      }]
    : [];

  return {
    id: baseId,
    name: draft.name.trim() || draft.clientName.trim() || primaryDomain,
    clientName: draft.clientName.trim() || draft.name.trim() || primaryDomain,
    primaryDomain,
    status: "active",
    environmentHealth: "watching",
    environments,
    accessMethods,
    memoryEntries: draft.description.trim()
      ? [{
          id: `${baseId}-memory-intro`,
          title: "Initial project context",
          type: "stack_note",
          importance: "high",
          content: draft.description.trim(),
        }]
      : [],
    recommendations: [
      {
        id: `${baseId}-recommendation-first-run`,
        category: "process",
        priority: "medium",
        status: "open",
        title: "Run first access verification and environment mapping pass.",
        summary: "This project is new to the system. The first run should confirm access, backup posture, stack facts, and QA expectations.",
      },
    ],
    riskFlags: [],
    contactEvents: [],
    qaRules: [
      {
        id: `${baseId}-qa-availability`,
        name: "Homepage availability",
        type: "availability_check",
        required: true,
        description: "Primary public pages should load before and after any production work.",
      },
      {
        id: `${baseId}-qa-login`,
        name: "Admin access sanity",
        type: "login_check",
        required: true,
        description: stackCopy[draft.stack].adminQaDescription,
      },
      {
        id: `${baseId}-qa-visual`,
        name: "Visual spot check",
        type: "visual_check",
        required: true,
        description: "Desktop and mobile spot checks should happen before a run closes.",
      },
    ],
    runs: [],
  };
};

export const createFirstRunDraft = (project: Project): RunDraft => ({
  title: "Initial access verification and environment mapping",
  taskType: "qa_only",
  taskSummary: `Establish the first safe operating baseline for ${project.name}. Verify access paths, inspect the environment, confirm the ${stackCopy[getProjectStack(project)].surfaceLabel}, and capture durable project memory before any write-capable work begins.`,
  urgency: "normal",
  environmentId: project.environments[0]?.id ?? "",
  accessReady: project.accessMethods.length > 0,
  backupConfirmed: false,
});

export const injectProjectIntoWorkspace = (workspace: Organization, project: Project): Organization => ({
  ...workspace,
  projects: [project, ...workspace.projects],
});

export const createRunFromDraft = (draft: RunDraft, project: Project): Run => {
  const nowStamp = "2026-08-04 22:24 CDT";
  const environment = project.environments.find((item) => item.id === draft.environmentId) ?? project.environments[0];
  // Conservative by design: anything write-capable — including deploys,
  // migrations, features, and dependency upgrades — stays high risk.
  const riskLevel = draft.taskType === "qa_only"
    ? "safe"
    : draft.taskType === "performance" || draft.taskType === "plugin_theme_conflict"
      ? "cautious"
      : "high_risk";
  const state = getRunEntryState(draft);

  const title = draft.title.trim() || `${taskTypeToTitle(draft.taskType)} run`;

  return {
    id: `run-${project.id}-${Date.now()}`,
    title,
    taskType: draft.taskType,
    taskSummary: draft.taskSummary.trim() || "Operator created a fresh run and still needs to add fuller context.",
    urgency: draft.urgency,
    environmentId: environment.id,
    state,
    riskLevel,
    backupStatus: draft.backupConfirmed ? "confirmed_by_operator" : "unconfirmed",
    approvalRequired: riskLevel === "high_risk",
    nextAction: draft.accessReady
      ? draft.taskType === "qa_only"
        ? "Inspect the environment, validate the listed access paths, and capture baseline memory notes."
        : draft.backupConfirmed
          ? "Map the environment and load project memory before diagnosis."
          : "Confirm backup evidence or restore readiness before any risky action."
      : "Validate access paths for the requested environment.",
    operatorPrompt: draft.taskType === "qa_only"
      ? "Use this first pass to verify access truth, note fragile areas, and sharpen the QA baseline before any fix run exists."
      : draft.backupConfirmed
        ? "Confirm whether the project memory has any fragility notes that should raise the effective risk level."
        : "Attach backup evidence before asking the agent to plan write-capable work.",
    // Left empty on purpose: the agent speaks for itself in the conversation.
    // Placeholder scaffolding text here used to be surfaced as chat messages
    // and read as filler next to the agent's own words.
    diagnosisSummary: "",
    planSummary: "",

    startedAt: nowStamp,
    updatedAt: nowStamp,
    phases: createPhases(state, draft.taskType),
    findings: [],
    actions: [
      {
        id: `action-${project.id}-${Date.now()}`,
        actor: "operator",
        summary: `Started a new ${taskTypeToTitle(draft.taskType).toLowerCase()} on ${environment.name}.`,
        outcome: "succeeded",
      },
    ],
    artifacts: draft.backupConfirmed
      ? [{ id: `artifact-${project.id}-backup`, type: "backup_note", title: "Backup confirmed", summary: "Operator confirmed a usable restore point before the run moved forward." }]
      : [],
    approvals: [],
    qaReport: {
      verdict: "partial",
      summary: "QA has not run yet because the run is still upstream of execution.",
      unresolvedRisks: ["QA is intentionally pending until execution or verification work finishes."],
      results: project.qaRules.map((rule) => ({
        id: `qa-${rule.id}`,
        name: rule.name,
        result: "skipped",
        notes: "This check has not run yet.",
      })),
    },
    recommendations: [],
  };
};
