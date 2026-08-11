/**
 * Stack awareness.
 *
 * One place decides what a project *is* and what words the interface may use
 * about it. Everything else — copy, access choices, version fields, tool
 * eligibility — derives from here rather than assuming WordPress.
 */

import type {
  AccessType,
  DeployPipeline,
  Project,
  ProjectEnvironment,
  ProjectStack,
  StackVersionInfo,
  TaskType,
} from "./types";

export const PROJECT_STACKS: ProjectStack[] = ["wordpress", "meteor", "nextjs", "custom"];

export type StackVersionField = { key: string; label: string; placeholder: string };

export type StackCopy = {
  label: string;
  /** Organization/project descriptor shown in the interface. */
  descriptor: string;
  /** What "the admin surface" is called for this stack, if it has one. */
  adminLabel: string | null;
  /** Human phrase for the thing the agent inspects. */
  surfaceLabel: string;
  versionFields: StackVersionField[];
  accessTypes: AccessType[];
  /** QA copy for the "can an operator still get in" rule. */
  adminQaDescription: string;
};

export const stackCopy: Record<ProjectStack, StackCopy> = {
  wordpress: {
    label: "WordPress",
    descriptor: "WordPress engineering command center",
    adminLabel: "WordPress Admin",
    surfaceLabel: "WordPress surface",
    versionFields: [
      { key: "wordpress", label: "WordPress version", placeholder: "6.7.1" },
      { key: "php", label: "PHP version", placeholder: "8.2" },
    ],
    accessTypes: ["wordpress_admin", "sftp", "ssh", "hosting_portal"],
    adminQaDescription:
      "WordPress admin should remain reachable after any change touching plugins, auth, or configuration.",
  },
  meteor: {
    label: "Meteor",
    descriptor: "Meteor engineering command center",
    adminLabel: null,
    surfaceLabel: "application surface",
    versionFields: [
      { key: "meteor", label: "Meteor version", placeholder: "2.15" },
      { key: "node", label: "Node version", placeholder: "22.22.1" },
      { key: "mongo", label: "MongoDB version", placeholder: "8.2.3" },
    ],
    accessTypes: ["ssh", "server_pm2", "ci_cd", "database", "hosting_portal"],
    adminQaDescription:
      "The application should stay reachable and the app process should stay healthy after any change.",
  },
  nextjs: {
    label: "Next.js",
    descriptor: "Next.js engineering command center",
    adminLabel: null,
    surfaceLabel: "application surface",
    versionFields: [
      { key: "nextjs", label: "Next.js version", placeholder: "15.1" },
      { key: "node", label: "Node version", placeholder: "22.x" },
    ],
    accessTypes: ["ci_cd", "hosting_portal", "ssh", "container"],
    adminQaDescription: "The deployed application should stay reachable after any change.",
  },
  custom: {
    label: "Custom",
    descriptor: "Engineering command center",
    adminLabel: null,
    surfaceLabel: "application surface",
    versionFields: [
      { key: "version", label: "Application version", placeholder: "1.0" },
      { key: "runtime", label: "Runtime", placeholder: "Node 22, Python 3.12..." },
    ],
    accessTypes: ["ssh", "hosting_portal", "ci_cd", "database"],
    adminQaDescription: "The application should stay reachable after any change.",
  },
};

export const isProjectStack = (value: unknown): value is ProjectStack =>
  typeof value === "string" && (PROJECT_STACKS as string[]).includes(value);

/**
 * A project's effective stack: production environment first, then the first
 * environment, then WordPress as the historical default. Single source of
 * truth — no other module infers a stack.
 */
export const getProjectStack = (project: Project | null | undefined): ProjectStack => {
  if (!project) return "wordpress";
  // Partial project shapes (fixtures, partially hydrated rows) must not throw.
  const environments = Array.isArray(project.environments) ? project.environments : [];
  const production = environments.find((environment) => environment.type === "production");
  return (production ?? environments[0])?.stack ?? "wordpress";
};

export const getStackCopy = (project: Project | null | undefined): StackCopy =>
  stackCopy[getProjectStack(project)];

export const isWordPressProject = (project: Project | null | undefined): boolean =>
  getProjectStack(project) === "wordpress";

/**
 * Legacy rows carry `wordpressVersion` / `phpVersion` and no `versions` map.
 * Hydration passes through here so nothing older breaks.
 */
export const normalizeVersions = (input: {
  versions?: StackVersionInfo | null;
  wordpressVersion?: string | null;
  phpVersion?: string | null;
}): StackVersionInfo => {
  const versions: StackVersionInfo = { ...(input.versions ?? {}) };
  if (!versions.wordpress && input.wordpressVersion) versions.wordpress = input.wordpressVersion;
  if (!versions.php && input.phpVersion) versions.php = input.phpVersion;
  return versions;
};

/** Human list, e.g. "Meteor 2.15 · Node 22.22.1". */
export const describeVersions = (environment: ProjectEnvironment): string => {
  const stack = environment.stack ?? "wordpress";
  const versions = normalizeVersions(environment);
  const fieldLabel = (key: string) =>
    stackCopy[stack].versionFields.find((field) => field.key === key)?.label.replace(/ version$/i, "") ??
    key.replace(/^\w/, (character) => character.toUpperCase());
  return Object.entries(versions)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${fieldLabel(key)} ${value}`)
    .join(" · ");
};

/** Operating facts that are true regardless of stack. */
export const describeRuntime = (environment: ProjectEnvironment): string =>
  [
    environment.runtime?.port ? `port ${environment.runtime.port}` : "",
    environment.runtime?.processManager ? `${environment.runtime.processManager} process manager` : "",
    environment.runtime?.databaseProvider
      ? `${environment.runtime.databaseProvider}${environment.runtime.databaseName ? ` (${environment.runtime.databaseName})` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

// --- deploy pipeline --------------------------------------------------------

export const rollbackCopy: Record<DeployPipeline["rollbackStrategy"], string> = {
  git_revert: "Revert the commit and redeploy",
  pm2_reload: "Reload the previous process build",
  snapshot_restore: "Restore from a snapshot",
};

/** Truthful build estimate. Renders "4-7 min" when a range exists. */
export const describeBuildTime = (pipeline: DeployPipeline): string => {
  const { buildTimeMinMinutes: min, buildTimeMaxMinutes: max, buildTimeMinutes: single } = pipeline;
  if (typeof min === "number" && typeof max === "number" && max > min) return `${min}-${max} min`;
  const value = single ?? min ?? max;
  return typeof value === "number" ? `${value} min` : "Not measured yet";
};

// --- task-aware presentation -------------------------------------------------

export const DEPLOY_TASK_TYPES: TaskType[] = ["deploy", "migration", "dependency_upgrade"];

export const isDeployTask = (taskType: TaskType): boolean => taskType === "deploy";

/** Access labels for every type, including the deploy-era connections. */
export const accessTypeLabels: Record<AccessType, string> = {
  wordpress_admin: "WordPress Admin",
  sftp: "SFTP / FTP",
  ssh: "SSH Access",
  hosting_portal: "Hosting / Other",
  database: "Database",
  cdn: "CDN",
  server_pm2: "Server process manager",
  ci_cd: "CI/CD pipeline",
  container: "Container platform",
};

/** Access types offered while creating a project on a given stack. */
export const accessTypesForStack = (stack: ProjectStack): AccessType[] => stackCopy[stack].accessTypes;