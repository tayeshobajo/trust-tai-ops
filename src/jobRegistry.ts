import { getSupabaseClient } from "./supabase";

/**
 * Job Registry resolver (Phase 4).
 *
 * The catalog lives in `captain_job_types`. When a task brief arrives, we
 * match its text against the catalog's `match_patterns` so the digest sent to
 * Captain carries a resolved job type (and the credential types that job
 * needs) instead of free text alone.
 *
 * Matching is intentionally simple and explainable: first pattern hit wins,
 * ordered by sort_order. No model call, no magic — the catalog is the source
 * of truth for what Captain can do.
 */

export type JobTypeRecord = {
  id: string;
  job_type: string;
  label: string;
  description: string | null;
  maps_to_task_type: string | null;
  required_credentials: string[];
  cloud_ready: boolean;
  trigger_kind: "manual" | "cron" | "monitor";
  match_patterns: string[];
  sort_order: number;
};

let cache: { at: number; rows: JobTypeRecord[] } | null = null;
const CACHE_TTL_MS = 60_000; // catalog changes are rare; 60s is plenty

export const loadJobCatalog = async (force = false): Promise<JobTypeRecord[]> => {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("captain_job_types")
      .select(
        "id, job_type, label, description, maps_to_task_type, required_credentials, cloud_ready, trigger_kind, match_patterns, sort_order",
      )
      .eq("enabled", true)
      .order("sort_order");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as JobTypeRecord[];
    cache = { at: Date.now(), rows };
    return rows;
  } catch {
    // Catalog is an accelerator, never a blocker: an unreadable catalog must
    // not stop a task from reaching Captain.
    return cache?.rows ?? [];
  }
};

export type JobMatch = {
  record: JobTypeRecord;
  matchedOn: string;
};

/**
 * First catalog pattern (by sort_order) that appears in the brief text.
 * Returns null when nothing matches — the task still flows to Captain as
 * free-form work.
 */
export const matchJobType = (brief: string, catalog: JobTypeRecord[]): JobMatch | null => {
  const text = brief.toLowerCase();
  for (const record of catalog) {
    for (const pattern of record.match_patterns) {
      if (pattern && text.includes(pattern.toLowerCase())) {
        return { record, matchedOn: pattern };
      }
    }
  }
  return null;
};

/** Resolves a brief against the catalog for display: "ssl_install" etc. */
export const resolvedJobLabel = (match: JobMatch | null): string | null =>
  match ? match.record.label : null;
