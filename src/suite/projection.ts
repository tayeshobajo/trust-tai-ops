/**
 * Ops -> Trust Tai Core project projection.
 *
 * Ops stays the canonical owner of Ops projects. Core receives a *read
 * projection*: a synchronized, org-scoped mirror it can list, search, and
 * deep link into, but never edit. The projection is keyed deterministically
 * on (organization_id, ops_project_id) so every sync is an upsert and a
 * replay can never create a second row.
 *
 * Honesty rules, enforced here rather than left to the reader:
 *  - a metric that Ops has not loaded is `null`, never `0`
 *  - a field Ops genuinely does not model (owner) is `null`
 *  - an archived or removed project is projected as such, not deleted quietly
 *
 * The matching Core-side DDL is in `db/core-contract/ops_project_projection.sql`.
 */

import { containsSecretMaterial, sanitizeSummary, OPS_APP_KEY } from "./osActivity";
import type { Project, Run } from "../types";

/** The Core table Ops upserts into. Core owns the DDL; Ops owns the rows. */
export const OPS_PROJECTION_TABLE = "ops_project_projection";

/** Deterministic conflict target for the upsert. */
export const OPS_PROJECTION_CONFLICT_TARGET = "organization_id,ops_project_id";

export type ProjectionLifecycle = "active" | "archived" | "removed";

export type OpsProjectProjectionRow = {
  organization_id: string;
  app_key: typeof OPS_APP_KEY;
  ops_project_id: string;
  canonical_project_id: string | null;
  client_label: string;
  project_name: string;
  primary_domain: string | null;
  status: string;
  lifecycle_state: ProjectionLifecycle;
  health: string | null;
  needs_attention: boolean;
  owner: string | null;
  open_issues: number | null;
  open_approvals: number | null;
  open_recommendations: number | null;
  open_risks: number | null;
  last_activity_at: string | null;
  /** Same-app absolute path, safe to hand back through the SSO `targetPath`. */
  ops_path: string;
  /** Absolute Ops destination for a new tab. */
  ops_url: string;
  source_updated_at: string | null;
  synced_at: string;
};

export type ProjectionContext = {
  /** The Core organization from the verified SSO handoff. */
  organizationId: string;
};

const ARCHIVED_STATUSES = new Set(["archived", "paused", "inactive", "offboarded"]);
const BLOCKED_RUN_STATES = new Set(["paused", "escalated", "failed", "rolled_back"]);
const OPEN_RECOMMENDATION_STATES = new Set(["open", "reviewed", "accepted"]);

/** The canonical Ops destination path for one project. */
export function projectionPath(opsProjectId: string): string {
  return `/projects/${encodeURIComponent(opsProjectId)}`;
}

export function projectionUrl(opsProjectId: string, opsBaseUrl: string): string {
  return `${opsBaseUrl.replace(/\/+$/, "")}${projectionPath(opsProjectId)}`;
}

/** `null` when Ops has not loaded the collection at all — never a false zero. */
function countOrUnknown<T>(items: T[] | undefined | null, predicate: (item: T) => boolean): number | null {
  if (!Array.isArray(items)) return null;
  return items.filter(predicate).length;
}

function latestActivityAt(project: Project): string | null {
  if (!Array.isArray(project.runs) || project.runs.length === 0) return null;
  const times = project.runs
    .map((run) => run.updatedAt || run.startedAt || "")
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort();
  return times.length > 0 ? times[times.length - 1] : null;
}

function openRuns(project: Project): Run[] | null {
  return Array.isArray(project.runs) ? project.runs.filter((run) => run.state !== "complete") : null;
}

export function buildProjectProjection(
  project: Project,
  context: ProjectionContext,
  opsBaseUrl: string,
  now: string = new Date().toISOString(),
  lifecycle: ProjectionLifecycle = ARCHIVED_STATUSES.has(String(project.status)) ? "archived" : "active",
): OpsProjectProjectionRow {
  const open = openRuns(project);
  const openApprovals = Array.isArray(project.runs)
    ? project.runs.reduce(
        (total, run) =>
          total + (Array.isArray(run.approvals) ? run.approvals.filter((a) => a.status === "pending").length : 0),
        0,
      )
    : null;

  const openRisks = countOrUnknown(
    project.riskFlags,
    (risk) => risk.status === "open" || risk.status === "monitoring",
  );

  const openRecommendations = Array.isArray(project.recommendations)
    ? [...project.recommendations, ...(project.runs ?? []).flatMap((run) => run.recommendations ?? [])].filter(
        (recommendation) => OPEN_RECOMMENDATION_STATES.has(recommendation.status),
      ).length
    : null;

  const blocked = (open ?? []).some((run) => BLOCKED_RUN_STATES.has(run.state));
  const needsAttention =
    lifecycle === "active" &&
    (blocked || (openApprovals ?? 0) > 0 || project.environmentHealth === "at_risk");

  const row: OpsProjectProjectionRow = {
    organization_id: context.organizationId,
    app_key: OPS_APP_KEY,
    ops_project_id: project.id,
    canonical_project_id: project.trustTaiOsProjectId ?? null,
    client_label: sanitizeSummary(project.clientName || project.name),
    project_name: sanitizeSummary(project.name),
    primary_domain: project.primaryDomain ? sanitizeSummary(project.primaryDomain) : null,
    status: String(project.status),
    lifecycle_state: lifecycle,
    health: project.environmentHealth ? String(project.environmentHealth) : null,
    needs_attention: needsAttention,
    // Ops does not model a project owner. Reporting one would be a fiction.
    owner: null,
    open_issues: open ? open.length : null,
    open_approvals: openApprovals,
    open_recommendations: openRecommendations,
    open_risks: openRisks,
    last_activity_at: latestActivityAt(project),
    ops_path: projectionPath(project.id),
    ops_url: projectionUrl(project.id, opsBaseUrl),
    source_updated_at: latestActivityAt(project),
    synced_at: now,
  };

  if (containsSecretMaterial(row)) {
    throw new Error("projection_contains_secret_material");
  }

  return row;
}

export function buildProjectionBatch(
  projects: Project[],
  context: ProjectionContext,
  opsBaseUrl: string,
  now: string = new Date().toISOString(),
): OpsProjectProjectionRow[] {
  return projects.map((project) => buildProjectProjection(project, context, opsBaseUrl, now));
}

/**
 * A project that Ops no longer holds is projected as `removed` rather than
 * silently disappearing, so Core can show the truth instead of a stale card.
 */
export function markProjectionRemoved(row: OpsProjectProjectionRow, now: string): OpsProjectProjectionRow {
  return { ...row, lifecycle_state: "removed", needs_attention: false, synced_at: now };
}

export type ProjectionSyncResult =
  | { status: "synced"; rows: number }
  | { status: "unavailable"; reason: "not_configured" | "no_os_session" | "no_organization" | "contract_missing" }
  | { status: "rejected"; reason: "secret_material" }
  | { status: "failed"; reason: string };

export type ProjectionSyncDeps = {
  context: ProjectionContext;
  /** Deterministic upsert on (organization_id, ops_project_id). */
  upsert: (rows: OpsProjectProjectionRow[]) => Promise<"synced" | "contract_missing">;
};

/** Fail-quiet: Core being unreachable never blocks Ops. */
export async function syncProjectionRows(
  rows: OpsProjectProjectionRow[],
  deps: ProjectionSyncDeps | null,
): Promise<ProjectionSyncResult> {
  if (!deps) return { status: "unavailable", reason: "no_os_session" };
  if (!deps.context?.organizationId) return { status: "unavailable", reason: "no_organization" };
  if (rows.length === 0) return { status: "synced", rows: 0 };
  if (containsSecretMaterial(rows)) return { status: "rejected", reason: "secret_material" };

  try {
    const outcome = await deps.upsert(rows);
    if (outcome === "contract_missing") return { status: "unavailable", reason: "contract_missing" };
    return { status: "synced", rows: rows.length };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "projection_sync_failed" };
  }
}