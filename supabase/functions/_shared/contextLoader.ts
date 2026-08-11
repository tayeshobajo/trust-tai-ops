/**
 * Server-side project context.
 *
 * The browser is never asked what a project knows. Every reasoning mode that
 * needs history reads it here, from the authorized project id, so a tampered
 * client cannot widen what the model sees.
 */

import { serviceClient } from "./clients.ts";
import { secretStoreDeps } from "./clients.ts";
import { capabilityTruth } from "./secretStore.ts";
import { buildProjectContext, type ContextInput, type ProjectContext } from "./projectContext.ts";

/**
 * Must match the access types the product actually stores. A name that does not
 * exist resolves to no credential, which would quietly report a project as
 * having less access than it has.
 */
export const EXECUTABLE_ACCESS_TYPES = ["wordpress_admin", "sftp", "ssh", "hosting_portal"];

const OPEN_STATES = [
  "intake",
  "access_check",
  "backup_gate",
  "environment_mapping",
  "diagnosis",
  "plan",
  "execution",
  "qa",
  "recommendations",
  "paused",
  "escalated",
];

const STACK_LABELS: Record<string, string> = {
  wordpress: "WordPress",
  meteor: "Meteor",
  nextjs: "Next.js",
  custom: "Custom stack",
};

type EnvironmentFacts = {
  stack?: string | null;
  versions?: Record<string, string> | null;
  runtime?: Record<string, unknown> | null;
  wordpress_version?: string | null;
  php_version?: string | null;
};

const describeStack = (environment: EnvironmentFacts): string =>
  STACK_LABELS[String(environment.stack ?? "wordpress")] ?? "";

/** Legacy rows only have the WordPress pair, so fold them into the map. */
const describeEnvironmentVersions = (environment: EnvironmentFacts): string => {
  const versions: Record<string, string> = { ...(environment.versions ?? {}) };
  if (!versions.wordpress && environment.wordpress_version) versions.wordpress = environment.wordpress_version;
  if (!versions.php && environment.php_version) versions.php = environment.php_version;
  return Object.entries(versions)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
};

const describeEnvironmentRuntime = (environment: EnvironmentFacts): string => {
  const runtime = environment.runtime ?? {};
  return [
    runtime.port ? `port ${runtime.port}` : "",
    runtime.processManager ? `${runtime.processManager} process manager` : "",
    runtime.databaseProvider ? String(runtime.databaseProvider) : "",
  ]
    .filter(Boolean)
    .join(", ");
};

export const loadProjectContext = async (
  projectId: string,
  canonicalUrl: string | null,
  focus = "",
): Promise<ProjectContext> => {
  const service = serviceClient();

  const [projectRow, environmentRow, memoryRows, runRows, messageRows, truth] = await Promise.all([
    service.from("projects").select("name, primary_domain, status").eq("id", projectId).maybeSingle(),
    service
      .from("project_environments")
      .select("environment_type, primary_url, hosting_provider, stack, versions, runtime, wordpress_version, php_version")
      .eq("project_id", projectId)
      .eq("environment_type", "production")
      .maybeSingle(),
    service
      .from("project_memory_entries")
      .select("id, title, content, memory_type, importance")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(60),
    service
      .from("runs")
      .select("id, title, state, next_action, diagnosis_summary, plan_summary")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(40),
    service
      .from("project_messages")
      .select("role, body, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(30),
    capabilityTruth(secretStoreDeps(), projectId, EXECUTABLE_ACCESS_TYPES).catch(() => ({
      stored: [] as string[],
      verified: [] as string[],
    })),
  ]);

  const environment = environmentRow.data;
  const runs = runRows.data ?? [];

  const input: ContextInput = {
    project: {
      name: String(projectRow.data?.name ?? "this project"),
      primaryDomain: String(projectRow.data?.primary_domain ?? ""),
      status: String(projectRow.data?.status ?? "active"),
      environment: environment
        ? [
            environment.hosting_provider,
            describeStack(environment),
            describeEnvironmentVersions(environment),
            describeEnvironmentRuntime(environment),
          ]
            .filter(Boolean)
            .join(", ")
        : "not mapped yet",
      canonicalUrl: canonicalUrl ?? (environment?.primary_url ? String(environment.primary_url) : null),
    },
    capabilities: truth,
    memory: (memoryRows.data ?? []).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      content: String(row.content ?? ""),
      type: String(row.memory_type ?? "stack_note"),
      importance: String(row.importance ?? "medium"),
    })),
    openRuns: runs
      .filter((row) => OPEN_STATES.includes(String(row.state)))
      .map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ""),
        state: String(row.state ?? ""),
        nextAction: String(row.next_action ?? ""),
      })),
    completedRuns: runs
      .filter((row) => !OPEN_STATES.includes(String(row.state)))
      .map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ""),
        outcome: String(row.plan_summary || row.diagnosis_summary || row.state || ""),
        qaVerdict: String(row.state) === "complete" ? "passed" : String(row.state ?? ""),
      })),
    // Newest-first from the query; the context wants them in reading order.
    messages: (messageRows.data ?? [])
      .slice()
      .reverse()
      .map((row) => ({
        role: String(row.role ?? "agent"),
        text: Array.isArray(row.body) ? row.body.join(" ") : String(row.body ?? ""),
      })),
  };

  return buildProjectContext(input, focus);
};

/** Memory titles the model can point at when it claims something is now stale. */
export const loadMemoryIndex = async (projectId: string): Promise<Array<{ id: string; title: string }>> => {
  const { data } = await serviceClient()
    .from("project_memory_entries")
    .select("id, title")
    .eq("project_id", projectId)
    .limit(200);
  return (data ?? []).map((row) => ({ id: String(row.id), title: String(row.title ?? "") }));
};