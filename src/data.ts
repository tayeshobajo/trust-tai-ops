import type { AccessType, ProjectDraft, Recommendation, RunDraft, RunPhase, RunState, TaskType, WorkspaceTab } from "./types";

export const workspaceTabs: Array<{ id: WorkspaceTab; label: string; detail: string }> = [
  { id: "overview", label: "Project Overview", detail: "Memory, risks, environments" },
  { id: "active_run", label: "Active Run", detail: "Shared operator-agent state" },
  { id: "qa", label: "QA Proof", detail: "Verdict, checks, residual risk" },
  { id: "history", label: "Recommendations", detail: "Recurring patterns and follow-up" },
  { id: "memory", label: "Project Memory", detail: "What the system should remember" },
];

export const taskTypeOptions: Array<{ value: TaskType; label: string; hint: string }> = [
  { value: "malware", label: "Malware / Security", hint: "Compromise investigation, cleanup, hardening." },
  { value: "performance", label: "Performance", hint: "Slow frontend, backend, or cache-layer diagnosis." },
  { value: "broken_site", label: "Broken Site", hint: "White screen, fatal errors, failed updates, recovery." },
  { value: "plugin_theme_conflict", label: "Plugin / Theme Conflict", hint: "Compatibility breakage and behavioral regressions." },
  { value: "hardening", label: "Hardening / Cleanup", hint: "Config tightening, cleanup, and preventive work." },
  { value: "qa_only", label: "QA / Verification", hint: "Post-change validation without a fix run." },
  { value: "deploy", label: "Deploy", hint: "Ship a change through the project's release pipeline." },
  { value: "migration", label: "Migration", hint: "Schema or data migration with rollback posture." },
  { value: "feature", label: "Feature", hint: "Build or change application behaviour." },
  { value: "dependency_upgrade", label: "Dependency Upgrade", hint: "Runtime, framework, or package version work." },
];

export const stateCopy: Record<RunState, { label: string; tone: string; guardrail: string }> = {
  intake: {
    label: "Intake",
    tone: "Clarifying the operator request and shaping the run.",
    guardrail: "No planning or execution yet. The task must become structured first.",
  },
  access_check: {
    label: "Access Check",
    tone: "Validating which doors are actually open.",
    guardrail: "No write-capable path until access and environment certainty are real.",
  },
  backup_gate: {
    label: "Backup Gate",
    tone: "Checking restore readiness before anything risky happens.",
    guardrail: "Cautious or high-risk changes stop here without backup confirmation.",
  },
  environment_mapping: {
    label: "Environment Mapping",
    tone: "Loading the stack, cache layers, and project memory before judgment.",
    guardrail: "Read-only evidence gathering only.",
  },
  diagnosis: {
    label: "Diagnosis",
    tone: "Naming the most likely root cause with evidence attached.",
    guardrail: "Execution cannot start without a written diagnosis artifact.",
  },
  plan: {
    label: "Plan",
    tone: "Turning diagnosis into a bounded fix path with rollback posture.",
    guardrail: "High-risk steps require explicit approval before they exist in production reality.",
  },
  execution: {
    label: "Execution",
    tone: "Carrying out the approved steps and logging every meaningful move.",
    guardrail: "No unplanned high-risk actions. Stop if the blast radius changes.",
  },
  qa: {
    label: "QA",
    tone: "Proving the result is real before anyone calls it done.",
    guardrail: "Completion is blocked until QA passes or an authorized waiver exists.",
  },
  recommendations: {
    label: "Recommendations",
    tone: "Turning the run into future leverage for the project and the team.",
    guardrail: "Close the loop with memory updates and follow-up policy recommendations.",
  },
  complete: {
    label: "Complete",
    tone: "Run closed with evidence, QA, and next actions captured.",
    guardrail: "No further execution actions allowed.",
  },
  paused: {
    label: "Paused",
    tone: "Waiting on a prerequisite, approval, or missing input.",
    guardrail: "The system must say exactly what is needed to resume.",
  },
  escalated: {
    label: "Escalated",
    tone: "The run found something outside safe autonomous handling.",
    guardrail: "Escalation is a safety outcome, not a vague error state.",
  },
  failed: {
    label: "Failed",
    tone: "The current plan exhausted itself without a safe completion path.",
    guardrail: "Failure still requires a structured summary and next step.",
  },
  rolled_back: {
    label: "Rolled Back",
    tone: "The system reversed course to restore safety or service.",
    guardrail: "Rollback must include verification, not just reversal.",
  },
};

export const phaseOrder: RunState[] = [
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
];

/**
 * Deploy runs use the same states and the same transitions. Only the words a
 * person reads change, because "Environment Mapping" is not what a release
 * actually is.
 */
const deployStateCopy: Partial<Record<RunState, { label: string; tone: string }>> = {
  environment_mapping: {
    label: "Pipeline Check",
    tone: "Verifying branch state and whether staging is current.",
  },
  diagnosis: {
    label: "Pre-deploy Verification",
    tone: "Confirming staging is live and the tests pass.",
  },
  execution: {
    label: "Deploy Execution",
    tone: "Merging, watching CI, and confirming the service comes back healthy.",
  },
  qa: {
    label: "Post-deploy Health Check",
    tone: "Checking the production URL, the process status, and the error rate.",
  },
};

/** The label and tone a person should see for a state, given the task. */
export const stateCopyFor = (state: RunState, taskType?: TaskType) => {
  const base = stateCopy[state];
  const override = taskType === "deploy" ? deployStateCopy[state] : undefined;
  return override ? { ...base, ...override } : base;
};

export const starterRunDraft = (environmentId: string): RunDraft => ({
  title: "",
  taskType: "performance",
  taskSummary: "",
  urgency: "normal",
  environmentId,
  accessReady: true,
  backupConfirmed: false,
});

export const starterProjectDraft = (): ProjectDraft => ({
  name: "",
  clientName: "",
  websiteUrl: "",
  description: "",
  hostingProvider: "",
  stack: "wordpress",
  versions: {},
  createProductionEnvironment: true,
  accessSelections: [
    { type: "wordpress_admin", enabled: false },
    { type: "sftp", enabled: false },
    { type: "ssh", enabled: false },
    { type: "hosting_portal", enabled: false },
  ],
});

export const accessTypeCopy: Record<AccessType, { label: string; detail: string; blurb: string }> = {
  wordpress_admin: {
    label: "WordPress Admin",
    detail: "Needed for most investigations and safe first-pass validation.",
    blurb: "Best first door for diagnosis, user review, and plugin-level inspection.",
  },
  sftp: {
    label: "SFTP / FTP",
    detail: "Useful for file inspection, uploads, and surgical edits.",
    blurb: "Ideal when the run may need theme, plugin, or upload-path review.",
  },
  ssh: {
    label: "SSH Access",
    detail: "Server-level access when deeper operations are required.",
    blurb: "Best for logs, CLI work, malware cleanup, and environment truth-finding.",
  },
  hosting_portal: {
    label: "Hosting / Other",
    detail: "Optional, but strong for backups, restores, and environment metadata.",
    blurb: "Useful for backup proof, staging context, and host-level verification.",
  },
  database: {
    label: "Database",
    detail: "Direct database access if a project needs it later.",
    blurb: "Not part of the default create-project card set.",
  },
  cdn: {
    label: "CDN",
    detail: "Cache or edge-layer access when a project needs it later.",
    blurb: "Not part of the default create-project card set.",
  },
  server_pm2: {
    label: "Server process manager",
    detail: "Where the application process runs and restarts.",
    blurb: "Recorded so the agent knows how the app is kept alive. Metadata only for now.",
  },
  ci_cd: {
    label: "CI/CD pipeline",
    detail: "The build and release pipeline for this project.",
    blurb: "Recorded so the agent understands how a change reaches production.",
  },
  container: {
    label: "Container platform",
    detail: "Container or orchestration platform, when one is in play.",
    blurb: "Recorded as environment truth. Metadata only for now.",
  },
};

export const recommendationSummary = (recommendations: Recommendation[]) =>
  recommendations.filter((item) => item.status === "open" || item.status === "accepted");

export const createPhases = (currentState: RunState, taskType?: TaskType): RunPhase[] =>
  phaseOrder.map((state, index) => {
    const currentIndex = phaseOrder.indexOf(currentState);
    const status =
      index < currentIndex
        ? "completed"
        : index === currentIndex
          ? "active"
          : "pending";

    const copy = stateCopyFor(state, taskType);

    return {
      id: state,
      state,
      label: copy.label,
      summary: copy.tone,
      status,
    };
  });
