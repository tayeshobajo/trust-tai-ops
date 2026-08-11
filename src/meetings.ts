/**
 * Meeting intelligence — browser side.
 *
 * The browser hands a transcript to the server and reads back proposals. It
 * never analyses, never decides, and never approves on the human's behalf.
 * Approval is a separate, explicit act performed here only after a person
 * clicks it.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "./env";
import { readReasonModelId } from "./agent-core/reasonModels";
import { getSupabaseClient } from "./supabase";
import type { RiskLevel, TaskType } from "./types";

export type MeetingProvenance = { chunkIndex: number; excerpt: string };

export type ProposedTask = {
  id: string;
  taskKey: string;
  title: string;
  clientAsk: string;
  taskType: TaskType;
  riskLevel: RiskLevel;
  needsInvestigation: boolean;
  accessNeeded: string[];
  dependsOn: string[];
  implementationApproach: string;
  verificationExpectation: string;
  requiresExecutionApproval: boolean;
  provenance: MeetingProvenance[];
  status: "proposed" | "approved" | "rejected" | "edited" | "superseded";
  runId: string | null;
};

export type MeetingAnalysisView = {
  analysisId: string;
  sourceId: string;
  sourceTitle: string;
  summary: string;
  decisions: Array<{ statement: string; madeBy: string; confidence: string; provenance: MeetingProvenance[] }>;
  constraints: Array<{ statement: string; kind: string }>;
  openQuestions: Array<{ question: string; whyItMatters: string }>;
  proposedTasks: ProposedTask[];
  memoryCandidates: Array<{ id: string; title: string; content: string; kind: string; importance: string }>;
};

export type MeetingResult =
  | { ok: true; analysis: MeetingAnalysisView; duplicate: boolean; redactedCount: number }
  | { ok: false; summary: string; retryable: boolean };

const unavailable: MeetingResult = {
  ok: false,
  summary: "I can't reach the meeting service from here yet, so I haven't stored anything.",
  retryable: true,
};

export const meetingIntelligenceAvailable = (): boolean => hasSupabasePublicConfig(resolveOpsEnv());

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const mapProposedTask = (row: Record<string, unknown>): ProposedTask => ({
  id: asString(row.id),
  taskKey: asString(row.task_key),
  title: asString(row.title),
  clientAsk: asString(row.client_ask),
  taskType: (asString(row.task_type, "qa_only") as TaskType),
  riskLevel: (asString(row.risk_level, "cautious") as RiskLevel),
  needsInvestigation: Boolean(row.needs_investigation),
  accessNeeded: asArray(row.access_needed).map((item) => String(item)),
  dependsOn: asArray(row.depends_on).map((item) => String(item)),
  implementationApproach: asString(row.implementation_approach),
  verificationExpectation: asString(row.verification_expectation),
  requiresExecutionApproval: row.requires_execution_approval !== false,
  provenance: asArray(row.provenance).map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return { chunkIndex: Number(entry.chunkIndex ?? 0), excerpt: asString(entry.excerpt) };
  }),
  status: (asString(row.status, "proposed") as ProposedTask["status"]),
  runId: typeof row.run_id === "string" ? row.run_id : null,
});

/** Reads the stored proposals for an analysis, which are the rows the human acts on. */
const loadAnalysisView = async (
  projectId: string,
  analysisId: string,
  sourceId: string,
  sourceTitle: string,
  result: Record<string, unknown>,
): Promise<MeetingAnalysisView> => {
  const client = getSupabaseClient();
  const [tasks, candidates] = await Promise.all([
    client.from("proposed_tasks").select("*").eq("project_id", projectId).eq("analysis_id", analysisId),
    client
      .from("memory_candidates")
      .select("id, title, content, kind, importance")
      .eq("project_id", projectId)
      .eq("analysis_id", analysisId),
  ]);

  return {
    analysisId,
    sourceId,
    sourceTitle,
    summary: asString(result.summary),
    decisions: asArray(result.decisions).map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return {
        statement: asString(entry.statement),
        madeBy: asString(entry.madeBy),
        confidence: asString(entry.confidence, "medium"),
        provenance: asArray(entry.provenance).map((p) => {
          const prov = (p ?? {}) as Record<string, unknown>;
          return { chunkIndex: Number(prov.chunkIndex ?? 0), excerpt: asString(prov.excerpt) };
        }),
      };
    }),
    constraints: asArray(result.constraints).map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return { statement: asString(entry.statement), kind: asString(entry.kind, "preference") };
    }),
    openQuestions: asArray(result.openQuestions).map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return { question: asString(entry.question), whyItMatters: asString(entry.whyItMatters) };
    }),
    proposedTasks: ((tasks.data ?? []) as Array<Record<string, unknown>>).map(mapProposedTask),
    memoryCandidates: ((candidates.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: asString(row.id),
      title: asString(row.title),
      content: asString(row.content),
      kind: asString(row.kind, "uncertain"),
      importance: asString(row.importance, "medium"),
    })),
  };
};

/** One call from the human's point of view: hand over a meeting, get back an understanding. */
export const ingestAndAnalyzeMeeting = async (input: {
  projectId: string;
  text: string;
  title?: string;
  occurredAt?: string;
  filename?: string;
}): Promise<MeetingResult> => {
  if (!meetingIntelligenceAvailable()) return unavailable;

  try {
    const client = getSupabaseClient();
    const ingest = await client.functions.invoke("ingest-source", {
      body: {
        projectId: input.projectId,
        text: input.text,
        title: input.title,
        occurredAt: input.occurredAt,
        filename: input.filename,
      },
    });
    if (ingest.error) return unavailable;

    const ingested = ingest.data as
      | { ok?: boolean; summary?: string; retryable?: boolean; duplicate?: boolean; source?: { id?: string; title?: string }; redaction?: { total?: number } }
      | null;
    if (!ingested?.ok || !ingested.source?.id) {
      return {
        ok: false,
        summary: asString(ingested?.summary, unavailable.summary),
        retryable: Boolean(ingested?.retryable),
      };
    }

    const sourceId = String(ingested.source.id);
    const analyzed = await client.functions.invoke("agent-reason", {
      body: {
        mode: "analyze_meeting_source",
        projectId: input.projectId,
        sourceId,
        model: readReasonModelId(),
      },
    });
    if (analyzed.error) {
      return { ok: false, summary: "I stored the transcript but couldn't read it through just now.", retryable: true };
    }

    const payload = analyzed.data as
      | { ok?: boolean; summary?: string; retryable?: boolean; analysisId?: string; analysis?: Record<string, unknown> }
      | null;
    if (!payload?.ok || !payload.analysisId || !payload.analysis) {
      return {
        ok: false,
        summary: asString(payload?.summary, "I stored the transcript but couldn't turn it into a plan yet."),
        retryable: Boolean(payload?.retryable),
      };
    }

    const analysis = await loadAnalysisView(
      input.projectId,
      String(payload.analysisId),
      sourceId,
      asString(ingested.source.title, "Client meeting"),
      payload.analysis,
    );

    return {
      ok: true,
      analysis,
      duplicate: Boolean(ingested.duplicate),
      redactedCount: Number(ingested.redaction?.total ?? 0),
    };
  } catch {
    return unavailable;
  }
};

/** Records a human decision on one proposal. Approval is never inferred. */
export const decideProposedTask = async (
  taskId: string,
  status: "approved" | "rejected",
  runId: string | null = null,
): Promise<boolean> => {
  if (!meetingIntelligenceAvailable()) return false;
  try {
    const client = getSupabaseClient();
    const { error } = await client
      .from("proposed_tasks")
      .update({ status, run_id: runId, decided_at: new Date().toISOString() } as never)
      .eq("id", taskId);
    return !error;
  } catch {
    return false;
  }
};

export const acceptMemoryCandidate = async (candidateId: string, accepted: boolean): Promise<boolean> => {
  if (!meetingIntelligenceAvailable()) return false;
  try {
    const client = getSupabaseClient();
    const { error } = await client
      .from("memory_candidates")
      .update({ status: accepted ? "accepted" : "rejected" } as never)
      .eq("id", candidateId);
    return !error;
  } catch {
    return false;
  }
};