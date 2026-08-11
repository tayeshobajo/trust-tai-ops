// Trust Tai Ops — the decision boundary for meeting proposals.
//
// Approving a proposal is the moment a sentence in a meeting becomes work on a
// live client site. That transition happens here and nowhere else: the browser
// can no longer write to any meeting table, so a person clicking "start this"
// is a request, and this function is the only thing that can honour it.
//
// Three properties matter, and all three are enforced below rather than in the
// interface:
//   - membership is proven before anything is read;
//   - the run's shape is computed from server truth, never from the caller;
//   - approval is idempotent, so a double click cannot create a second run.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, secretStoreDeps, serviceClient } from "../_shared/clients.ts";
import { capabilityTruth } from "../_shared/secretStore.ts";
import { EXECUTABLE_ACCESS_TYPES } from "../_shared/contextLoader.ts";
import { buildRunSeed } from "../_shared/runInit.ts";

const fail = (code: string, summary: string, retryable: boolean) =>
  Response.json({ ok: false, code, summary, retryable }, { headers: corsHeaders });

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you signed in before I can act on that.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

/** Does this project have any door at all? Decides whether a run opens at the access gate. */
const projectHasAccess = async (projectId: string): Promise<boolean> => {
  const truth = await capabilityTruth(secretStoreDeps(), projectId, EXECUTABLE_ACCESS_TYPES).catch(() => ({
    stored: [] as string[],
    verified: [] as string[],
  }));
  if (truth.stored.length > 0) return true;

  const methods = await serviceClient()
    .from("project_access_methods")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "available")
    .limit(1);
  return (methods.data ?? []).length > 0;
};

const resolveEnvironmentId = async (projectId: string): Promise<string | null> => {
  const service = serviceClient();
  const production = await service
    .from("project_environments")
    .select("id")
    .eq("project_id", projectId)
    .eq("environment_type", "production")
    .maybeSingle();
  if (production.data?.id) return String(production.data.id);

  const any = await service.from("project_environments").select("id").eq("project_id", projectId).limit(1);
  const first = (any.data ?? [])[0];
  return first ? String(first.id) : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("invalid_input", "Unsupported request.", false);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_input", "I couldn't read that request.", false);
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!projectId) return fail("invalid_input", "No project was named.", false);

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before changing anything.", false);

  const ownedProjectId = authz.project.projectId;
  const actor = authz.caller.userId;
  const service = serviceClient();

  if (action === "decide_memory") {
    const candidateId = typeof body.candidateId === "string" ? body.candidateId : "";
    const accepted = body.accepted === true;
    if (!candidateId) return fail("invalid_input", "No memory was named.", false);

    // Scoped on the query: a candidate from another project does not exist here.
    const candidate = await service
      .from("memory_candidates")
      .select("id")
      .eq("id", candidateId)
      .eq("project_id", ownedProjectId)
      .maybeSingle();
    if (!candidate.data) return fail("not_found", "I couldn't find that note on this project.", false);

    const decided = await service.rpc("meeting_decide_memory_candidate", {
      _candidate_id: candidateId,
      _actor: actor,
      _accepted: accepted,
    });
    if (decided.error) {
      console.error(`meeting-decisions memory failed: ${decided.error.message}`);
      return fail("decision_failed", "I couldn't record that just now. Nothing changed.", true);
    }
    return Response.json(
      { ok: true, accepted, memoryId: decided.data ? String(decided.data) : null },
      { headers: corsHeaders },
    );
  }

  if (action !== "approve_proposal" && action !== "reject_proposal") {
    return fail("invalid_input", "I don't know how to do that.", false);
  }

  const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
  if (!proposalId) return fail("invalid_input", "No proposal was named.", false);

  const proposal = await service
    .from("proposed_tasks")
    .select("id, title, client_ask, implementation_approach, task_type, risk_level, requires_execution_approval, status, run_id")
    .eq("id", proposalId)
    .eq("project_id", ownedProjectId)
    .maybeSingle();
  if (!proposal.data) return fail("not_found", "I couldn't find that proposal on this project.", false);

  if (action === "reject_proposal") {
    const rejected = await service.rpc("meeting_reject_proposal", {
      _proposal_id: proposalId,
      _actor: actor,
      _note: typeof body.note === "string" ? body.note.slice(0, 400) : "",
    });
    if (rejected.error) {
      console.error(`meeting-decisions reject failed: ${rejected.error.message}`);
      return fail("decision_failed", "I couldn't record that just now. Nothing changed.", true);
    }
    return Response.json({ ok: true, status: "rejected" }, { headers: corsHeaders });
  }

  // Already started. Report the run that exists instead of making another.
  if (proposal.data.run_id) {
    return Response.json(
      { ok: true, status: "approved", runId: String(proposal.data.run_id), alreadyStarted: true },
      { headers: corsHeaders },
    );
  }

  const environmentId = await resolveEnvironmentId(ownedProjectId);
  if (!environmentId) {
    return fail("environment_missing", "This project has no environment recorded yet, so I can't start work on it.", false);
  }

  const seed = buildRunSeed({
    title: String(proposal.data.title ?? ""),
    taskType: String(proposal.data.task_type ?? "qa_only"),
    taskSummary: String(proposal.data.client_ask || proposal.data.implementation_approach || proposal.data.title || ""),
    environmentId,
    accessReady: await projectHasAccess(ownedProjectId),
    // A meeting never establishes a restore point.
    backupConfirmed: false,
    riskLevel: String(proposal.data.risk_level ?? "cautious"),
    requiresExecutionApproval: proposal.data.requires_execution_approval !== false,
  });

  const approved = await service.rpc("meeting_approve_proposal", {
    _proposal_id: proposalId,
    _actor: actor,
    _run: seed,
    _phases: [],
    _approved_proposal: null,
  });

  if (approved.error) {
    console.error(`meeting-decisions approve failed: ${approved.error.message}`);
    const alreadyDecided = /already_decided|already_started/.test(approved.error.message);
    return fail(
      alreadyDecided ? "already_decided" : "decision_failed",
      alreadyDecided
        ? "That proposal was already decided, so I left it alone."
        : "I couldn't start that task. Nothing was changed.",
      !alreadyDecided,
    );
  }

  return Response.json(
    { ok: true, status: "approved", runId: approved.data ? String(approved.data) : null, alreadyStarted: false },
    { headers: corsHeaders },
  );
});