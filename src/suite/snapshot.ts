/**
 * Ops intelligence snapshot.
 *
 * The smallest useful, deterministic, evidence-backed reading of one Ops
 * project. No model call, no raw logs, no credentials — every claim cites the
 * Ops row it came from so Trust Tai OS Ask/Pulse can trust and trace it.
 */

import { sanitizeSummary, containsSecretMaterial } from "./osActivity";
import type { Project, Run } from "../types";

export type SnapshotCitation = { kind: "run" | "qa_report" | "recommendation" | "approval" | "risk" | "project"; id: string };

export type OpsSnapshot = {
  opsProjectId: string;
  canonicalProjectId: string | null;
  generatedAt: string;
  health: {
    status: Project["environmentHealth"];
    projectStatus: Project["status"];
    openRisks: number;
  };
  activeRun: { id: string; title: string; state: Run["state"]; nextAction: string } | null;
  blocker: { runId: string; summary: string } | null;
  pendingApproval: { runId: string; approvalId: string; type: string; reason: string } | null;
  latestQa: { runId: string; verdict: string; summary: string; unresolvedRisks: string[] } | null;
  unresolvedRecommendations: Array<{ id: string; priority: string; title: string }>;
  lastMeaningfulEvent: { runId: string; summary: string; at: string } | null;
  evidenceRefs: Array<{ runId: string; artifactId: string; type: string; title: string }>;
  citations: SnapshotCitation[];
};

const OPEN_RECOMMENDATION_STATES = new Set(["open", "reviewed", "accepted"]);
const BLOCKED_STATES = new Set(["paused", "escalated", "failed", "rolled_back"]);

function mostRecent(runs: Run[]): Run | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

export function buildOpsSnapshot(project: Project, now: string = new Date().toISOString()): OpsSnapshot {
  const citations: SnapshotCitation[] = [{ kind: "project", id: project.id }];

  const openRuns = project.runs.filter((run) => run.state !== "complete");
  const activeRun = mostRecent(openRuns) ?? null;
  if (activeRun) citations.push({ kind: "run", id: activeRun.id });

  const blockedRun = openRuns.find((run) => BLOCKED_STATES.has(run.state)) ?? null;

  let pendingApproval: OpsSnapshot["pendingApproval"] = null;
  for (const run of project.runs) {
    const approval = run.approvals.find((entry) => entry.status === "pending");
    if (approval) {
      pendingApproval = {
        runId: run.id,
        approvalId: approval.id,
        type: approval.type,
        reason: sanitizeSummary(approval.reason),
      };
      citations.push({ kind: "approval", id: approval.id });
      break;
    }
  }

  const qaRun = mostRecent(project.runs.filter((run) => Boolean(run.qaReport?.verdict))) ?? null;
  const latestQa = qaRun
    ? {
        runId: qaRun.id,
        verdict: qaRun.qaReport.verdict,
        summary: sanitizeSummary(qaRun.qaReport.summary ?? ""),
        unresolvedRisks: (qaRun.qaReport.unresolvedRisks ?? []).map(sanitizeSummary),
      }
    : null;
  if (qaRun) citations.push({ kind: "qa_report", id: qaRun.id });

  const unresolvedRecommendations = [
    ...project.recommendations,
    ...project.runs.flatMap((run) => run.recommendations),
  ]
    .filter((recommendation) => OPEN_RECOMMENDATION_STATES.has(recommendation.status))
    .map((recommendation) => {
      citations.push({ kind: "recommendation", id: recommendation.id });
      return { id: recommendation.id, priority: recommendation.priority, title: sanitizeSummary(recommendation.title) };
    });

  const lastRun = mostRecent(project.runs);
  const lastAction = lastRun ? [...lastRun.actions].reverse().find((action) => action.outcome !== "pending") : null;
  const lastMeaningfulEvent = lastRun
    ? {
        runId: lastRun.id,
        summary: sanitizeSummary(lastAction?.summary ?? lastRun.nextAction ?? lastRun.title),
        at: lastRun.updatedAt,
      }
    : null;

  const evidenceRefs = project.runs.flatMap((run) =>
    run.artifacts.map((artifact) => ({
      runId: run.id,
      artifactId: artifact.id,
      type: artifact.type,
      title: sanitizeSummary(artifact.title),
    })),
  );

  const openRisks = project.riskFlags.filter((risk) => risk.status === "open" || risk.status === "monitoring");
  for (const risk of openRisks) citations.push({ kind: "risk", id: risk.id });

  const snapshot: OpsSnapshot = {
    opsProjectId: project.id,
    canonicalProjectId: project.trustTaiOsProjectId ?? null,
    generatedAt: now,
    health: {
      status: project.environmentHealth,
      projectStatus: project.status,
      openRisks: openRisks.length,
    },
    activeRun: activeRun
      ? {
          id: activeRun.id,
          title: sanitizeSummary(activeRun.title),
          state: activeRun.state,
          nextAction: sanitizeSummary(activeRun.nextAction),
        }
      : null,
    blocker: blockedRun
      ? { runId: blockedRun.id, summary: sanitizeSummary(blockedRun.operatorPrompt || blockedRun.nextAction) }
      : null,
    pendingApproval,
    latestQa,
    unresolvedRecommendations,
    lastMeaningfulEvent,
    evidenceRefs,
    citations,
  };

  // Defensive: the snapshot is meant to leave Ops, so it is checked with the
  // same rule the sync path uses.
  if (containsSecretMaterial(snapshot)) {
    throw new Error("snapshot_contains_secret_material");
  }

  return snapshot;
}