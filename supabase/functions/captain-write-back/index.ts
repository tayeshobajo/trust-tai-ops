// Trust Tai Ops — Captain write-back boundary.
//
// Captain (OpenClaw) calls this endpoint after completing a job to persist a
// structured outcome record. This is the "memory" half of the intelligence
// layer: every Captain job that touches a real system ends with a row in
// captain_outcomes.
//
// Auth: shared secret (CAPTAIN_WRITE_BACK_KEY) — Captain-side only, never
// browser-reachable. The browser reads outcomes through the authenticated RLS
// select policy, never through this function.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { serviceClient } from "../_shared/clients.ts";

const fail = (code: string, summary: string, status = 400) =>
  Response.json({ ok: false, code, summary }, { status, headers: corsHeaders });

type OutcomePayload = {
  project_id: string;
  request_id?: string | null;
  job_type: string;
  target: string;
  verdict: "pass" | "fail" | "partial";
  summary: string;
  evidence?: string | null;
  outcome_data?: Record<string, unknown>;
  next_action_type?: string | null;
  next_action_due_at?: string | null;
  captain_session_ref?: string | null;
  completed_by?: string;
};

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const VERDICTS = new Set(["pass", "fail", "partial"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", "POST only", 405);

  // --- Shared-secret auth ---
  const key = Deno.env.get("CAPTAIN_WRITE_BACK_KEY");
  if (!key) return fail("write_back_unconfigured", "CAPTAIN_WRITE_BACK_KEY not set", 500);

  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  if (token.length === 0 || token !== key) {
    return fail("unauthorized", "Missing or invalid write-back key", 401);
  }

  // --- Payload ---
  let payload: OutcomePayload;
  try {
    payload = await req.json();
  } catch {
    return fail("bad_json", "Body must be JSON");
  }

  const {
    project_id,
    request_id,
    job_type,
    target,
    verdict,
    summary,
    evidence,
    outcome_data,
    next_action_type,
    next_action_due_at,
    captain_session_ref,
    completed_by,
  } = payload;

  // --- Validation ---
  if (!isNonEmptyString(project_id)) return fail("missing_project_id", "project_id required");
  if (!isNonEmptyString(job_type)) return fail("missing_job_type", "job_type required");
  if (!isNonEmptyString(target)) return fail("missing_target", "target required");
  if (!isNonEmptyString(summary)) return fail("missing_summary", "summary required");
  if (!VERDICTS.has(verdict)) return fail("bad_verdict", "verdict must be pass|fail|partial");

  if (next_action_due_at !== undefined && next_action_due_at !== null) {
    if (typeof next_action_due_at !== "string" || Number.isNaN(Date.parse(next_action_due_at))) {
      return fail("bad_next_action_due_at", "next_action_due_at must be an ISO timestamp");
    }
  }

  // project must exist — fail closed on unknown projects
  const db = serviceClient();
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id, organization_id, primary_domain")
    .eq("id", project_id)
    .maybeSingle();

  if (projectError) return fail("project_lookup_failed", projectError.message, 500);
  if (!project) return fail("project_not_found", `No project with id ${project_id}`, 404);

  // request_id, if provided, must belong to the same project
  if (request_id) {
    const { data: reqRow, error: reqError } = await db
      .from("captain_plan_requests")
      .select("id, project_id")
      .eq("id", request_id)
      .maybeSingle();
    if (reqError) return fail("request_lookup_failed", reqError.message, 500);
    if (!reqRow) return fail("request_not_found", `No captain_plan_request ${request_id}`, 404);
    if (reqRow.project_id !== project_id) {
      return fail("request_project_mismatch", "request_id belongs to a different project", 409);
    }
  }

  // --- Insert ---
  const insert = {
    project_id,
    request_id: request_id ?? null,
    job_type: job_type.trim(),
    target: target.trim(),
    verdict,
    summary,
    evidence: evidence ?? null,
    outcome_data: outcome_data && typeof outcome_data === "object" ? outcome_data : {},
    next_action_type: next_action_type?.trim() || null,
    next_action_due_at: next_action_due_at ?? null,
    captain_session_ref: captain_session_ref?.trim() || null,
    completed_by: isNonEmptyString(completed_by) ? completed_by.trim() : "captain",
  };

  const { data: inserted, error: insertError } = await db
    .from("captain_outcomes")
    .insert(insert)
    .select("id, created_at")
    .single();

  if (insertError) return fail("insert_failed", insertError.message, 500);

  // --- Optional: post an outcome message into project chat so the team sees it ---
  // NOTE: project_messages.body is text[] — body[0] is the message text.
  const outcomeMsg = [
    `✅ Captain outcome recorded — ${job_type} on ${target}`,
    ``,
    `Verdict: ${verdict.toUpperCase()}`,
    summary,
  ].join("\n");

  await db.from("project_messages").insert({
    project_id,
    role: "agent",
    kind: "status_update",
    body: [outcomeMsg],
    dedupe_key: `captain-outcome-${inserted.id}`,
  });

  return Response.json(
    { ok: true, outcome_id: inserted.id, created_at: inserted.created_at },
    { headers: corsHeaders },
  );
});
