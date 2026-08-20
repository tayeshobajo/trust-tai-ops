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
import { displayFilename } from "./evidencePolicy.ts";
import { redactEvidenceText } from "./evidenceAnalysis.ts";
import type { RetrievedConversation, ServerEvidence } from "./reasonPrompt.ts";
import { whenLabel } from "./continuity/retrieval.ts";

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

  const [projectRow, environmentRow, memoryRows, runRows, messageRows, evidenceRows, truth] = await Promise.all([
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
    // Attachments the human shared, newest first. Only the normalized analysis
    // is read: the stored object itself never enters a prompt from here.
    service
      .from("project_evidence")
      .select("safe_filename, evidence_kind, status, evidence_analyses(result, status)")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(12),
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
    evidence: (evidenceRows.data ?? []).map((row) => {
      const analyses = Array.isArray(row.evidence_analyses) ? row.evidence_analyses : [];
      const latest = (analyses[analyses.length - 1] ?? {}) as { result?: Record<string, unknown> };
      const result = (latest.result ?? {}) as Record<string, unknown>;
      const summary = typeof result.summary === "string" ? [result.summary] : [];
      const observations = Array.isArray(result.observations)
        ? result.observations.filter((item): item is string => typeof item === "string")
        : [];
      const signals = Array.isArray(result.technicalSignals)
        ? result.technicalSignals.filter((item): item is string => typeof item === "string")
        : [];
      return {
        filename: String(row.safe_filename ?? "attachment"),
        kind: String(row.evidence_kind ?? "other"),
        status: String(row.status ?? "stored"),
        observations: [...summary, ...observations, ...signals].slice(0, 10),
      };
    }),
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
/**
 * Attachments belonging to one run, read server-side.
 *
 * Ordinary run reasoning is run-scoped on purpose: injecting the newest twelve
 * files from unrelated old tasks would let stale evidence steer a live one. The
 * run is verified to belong to the authorized project before this is called.
 * Only analyses that actually completed contribute observations.
 */
export const loadRunEvidence = async (projectId: string, runId: string): Promise<ServerEvidence[]> => {
  const { data } = await serviceClient()
    .from("project_evidence")
    .select("safe_filename, evidence_kind, status, evidence_analyses(result, status, version)")
    .eq("project_id", projectId)
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .limit(12);

  return (data ?? []).map((row) => {
    const analyses = (Array.isArray(row.evidence_analyses) ? row.evidence_analyses : []) as Array<{
      result?: Record<string, unknown>;
      status?: string;
      version?: number;
    }>;
    const latest = analyses.slice().sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0)).pop();
    const result = (latest?.result ?? {}) as Record<string, unknown>;
    const readable = String(latest?.status ?? "") === "complete" && String(result.status ?? "") === "complete";
    const summary = typeof result.summary === "string" ? result.summary : "";

    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

    return {
      filename: displayFilename(String(row.safe_filename ?? "attachment")),
      kind: String(row.evidence_kind ?? "other"),
      readable,
      stateSummary: readable
        ? ""
        : redactEvidenceText(summary || `I have this file but haven't been able to read it (${row.status}).`).slice(0, 240),
      observations: readable
        ? [summary, ...strings(result.observations), ...strings(result.technicalSignals)]
            .filter(Boolean)
            .map((item) => redactEvidenceText(item).slice(0, 300))
            .slice(0, 10)
        : [],
      warnings: strings(result.warnings).map((item) => redactEvidenceText(item).slice(0, 200)).slice(0, 3),
    };
  });
};

/** The run must belong to the authorized project before its evidence is read. */
export const runBelongsToProject = async (projectId: string, runId: string): Promise<boolean> => {
  const { data } = await serviceClient().from("runs").select("project_id").eq("id", runId).maybeSingle();
  return Boolean(data && String(data.project_id) === projectId);
};

/** A resolution older than this belongs to a different conversation. */
const RECALL_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Conversation the person pointed back at.
 *
 * The browser tells us which task it is working in; it never tells us what was
 * said in it. The references were written by the continuity boundary at
 * resolution time, so this read is the project's own record replayed under a
 * truthful label — not a client claim about its own history.
 */
export const loadRetrievedConversation = async (
  projectId: string,
  runId: string | null,
  now = Date.now(),
): Promise<RetrievedConversation[]> => {
  const service = serviceClient();
  const since = new Date(now - RECALL_WINDOW_MS).toISOString();

  let query = service
    .from("message_references")
    .select(
      "label, summary, created_at, project_messages!message_references_source_message_id_fkey(body, created_at)",
    )
    .eq("project_id", projectId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(4);

  if (runId) query = query.eq("run_id", runId);

  const { data } = await query;

  return (data ?? []).map((row) => {
    const source = (Array.isArray(row.project_messages) ? row.project_messages[0] : row.project_messages) as
      | { body?: unknown; created_at?: string }
      | null;
    const body = Array.isArray(source?.body) ? source?.body.join(" ") : "";
    const at = String(source?.created_at ?? row.created_at ?? new Date(now).toISOString());
    return {
      label: row.label ? String(row.label) : null,
      text: redactEvidenceText(String(row.summary || body || "")).slice(0, 400),
      when: whenLabel(at, now),
    };
  });
};

// ---------------------------------------------------------------------------
// Knowledge base pattern lookup
// ---------------------------------------------------------------------------

export type KnowledgeBasePattern = {
  symptom: string;
  resolution: string;
  evidenceSignals: string[];
  host: string | null;
};

/**
 * Fetch the top matching diagnostic patterns from the knowledge_base_entries
 * table for the given task type. Host-specific patterns are boosted to the
 * front when the project's hosting provider is known.
 *
 * Returns at most 4 patterns, bounded so they never dominate the prompt.
 */
export const loadKnowledgeBasePatterns = async (
  service: ReturnType<typeof createClient>,
  taskType: string,
  hostingProvider: string | null,
): Promise<KnowledgeBasePattern[]> => {
  if (!taskType || taskType === "unknown") return [];

  const { data } = await service
    .from("knowledge_base_entries")
    .select("symptom_pattern, resolution, evidence_signals, host_context")
    .eq("scope", "wordpress")
    .eq("task_type", taskType)
    .order("project_count", { ascending: false })
    .limit(12);

  if (!data || data.length === 0) return [];

  const rows = data as Array<{
    symptom_pattern: string;
    resolution: string;
    evidence_signals: unknown;
    host_context: string | null;
  }>;

  // Sort: host-matching entries first, then generic ones.
  const host = hostingProvider ? hostingProvider.toLowerCase() : null;
  const sorted = rows.slice().sort((a, b) => {
    const aMatch = host && a.host_context && a.host_context.toLowerCase() === host ? -1 : 0;
    const bMatch = host && b.host_context && b.host_context.toLowerCase() === host ? -1 : 0;
    return aMatch - bMatch;
  });

  return sorted.slice(0, 4).map((row) => ({
    symptom: String(row.symptom_pattern ?? "").slice(0, 200),
    resolution: String(row.resolution ?? "").slice(0, 600),
    evidenceSignals: Array.isArray(row.evidence_signals)
      ? (row.evidence_signals as unknown[]).map((s) => String(s).slice(0, 100)).slice(0, 5)
      : [],
    host: row.host_context ?? null,
  }));
};
