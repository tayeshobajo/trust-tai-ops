// Trust Tai Ops — autonomous site monitor.
//
// Called by a cron trigger (HTTP POST) or directly by an operator.
// Sweeps one or all active projects, runs a lightweight health check via
// agent-reason, and writes risk flags when issues are found.
//
// Severity routing:
//   low / medium → write project_risk_flags row, no auto-fix
//   high         → write project_risk_flags + attempt auto-fix via agent-execute
//
// Auth: MONITOR_SECRET header, or Supabase service-role JWT.
// Nothing here ever talks to a model — it delegates to agent-reason.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MonitorRequest = {
  project_id?: string; // if present, monitor only this project
};

type MonitorIssue = {
  project_id: string;
  severity: "low" | "medium" | "high";
  title: string;
  summary: string;
  action_taken: "flagged" | "auto_fix_attempted" | "auto_fix_succeeded" | "auto_fix_failed";
};

type MonitorResult = {
  ok: boolean;
  monitored: number;
  issues: MonitorIssue[];
  errors: string[];
};

type ProjectRow = {
  id: string;
  name: string;
  primary_domain: string;
  status: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const FUNCTION_BASE = SUPABASE_URL.replace("/rest/v1", "").replace(/\/$/, "");

// Read these per-request so new env vars picked up after deploy take effect
// without waiting for a cold-start cycle.
const getServiceRoleKey = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const getMonitorSecret = () => Deno.env.get("MONITOR_SECRET") ?? "";

const MONITOR_PROMPT = `You are performing a rapid automated health check on a WordPress site.
Check the following areas and return a JSON object:
{
  "severity": "none" | "low" | "medium" | "high",
  "title": "Short title of the primary issue, or 'No issues found'",
  "summary": "2-3 sentence summary of findings",
  "findings": ["finding 1", "finding 2"],
  "recommended_fix": "What should be done, or null if no action needed",
  "auto_fixable": true | false
}

Focus on:
1. Site uptime and response time
2. WordPress error log — any PHP fatal errors or repeated warnings in last 100 lines
3. Plugin update availability (security-relevant only)
4. Cache health — is it serving stale content?
5. If The Events Calendar is active: verify event timezone fields are intact

If the site is unreachable, severity is always "high".
If there are PHP fatals in the last hour, severity is at least "medium".
Be conservative — only flag real issues, not warnings you cannot verify.`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Decode a JWT payload without verifying the signature (trust is already
 * established by Supabase's gateway layer which validates the JWT before
 * the function handler runs). We only read the `role` claim.
 */
const jwtRole = (authHeader: string): string | null => {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const payloadB64 = token.split(".")[1] ?? "";
    // atob requires standard base64 — add padding and replace URL-safe chars
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
    const payload = JSON.parse(json) as Record<string, unknown>;
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
};

const authorized = (req: Request): boolean => {
  const secret = getMonitorSecret();

  // 1. MONITOR_SECRET token (primary path for cron / external callers)
  const monitorToken = req.headers.get("x-monitor-token");
  if (secret && monitorToken === secret) return true;

  // 2. Supabase JWT with service_role — Supabase already validated the JWT;
  //    we just confirm the role claim says service_role.
  const authHeader = req.headers.get("authorization") ?? "";
  if (jwtRole(authHeader) === "service_role") return true;

  return false;
};

// ---------------------------------------------------------------------------
// Supabase service client
// ---------------------------------------------------------------------------

const serviceDb = () =>
  createClient(SUPABASE_URL, getServiceRoleKey(), {
    auth: { persistSession: false },
  });

// ---------------------------------------------------------------------------
// Fetch active projects
// ---------------------------------------------------------------------------

const fetchProjects = async (projectId?: string): Promise<ProjectRow[]> => {
  const db = serviceDb();
  let query = db
    .from("projects")
    .select("id, name, primary_domain, status")
    .eq("status", "active");

  if (projectId) {
    query = query.eq("id", projectId);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  return data as ProjectRow[];
};

// ---------------------------------------------------------------------------
// Call agent-reason in monitor mode (lightweight inspect)
// ---------------------------------------------------------------------------

type ReasonSummary = {
  severity: "none" | "low" | "medium" | "high";
  title: string;
  summary: string;
  findings: string[];
  recommended_fix: string | null;
  auto_fixable: boolean;
};

const DEFAULT_SUMMARY: ReasonSummary = {
  severity: "none",
  title: "No issues found",
  summary: "Health check completed with no actionable findings.",
  findings: [],
  recommended_fix: null,
  auto_fixable: false,
};

const callAgentReason = async (projectId: string, domain: string): Promise<ReasonSummary> => {
  try {
    const url = `${FUNCTION_BASE}/functions/v1/agent-reason`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getServiceRoleKey()}`,
      },
      body: JSON.stringify({
        mode: "monitor",
        project_id: projectId,
        monitor_prompt: MONITOR_PROMPT,
        domain,
      }),
      signal: AbortSignal.timeout(90_000), // 90s per project
    });

    if (!res.ok) {
      console.warn("agent-reason monitor call failed", { projectId, status: res.status });
      // Site unreachable or agent error — treat as high severity
      return {
        severity: "high",
        title: "Agent health check failed",
        summary: `The health check for ${domain} could not complete (agent-reason returned ${res.status}).`,
        findings: [`HTTP ${res.status} from agent-reason`],
        recommended_fix: "Investigate the ops agent and try again.",
        auto_fixable: false,
      };
    }

    const body = await res.json();

    // agent-reason in monitor mode returns { ok, monitor_result: {...} }
    if (body?.monitor_result && typeof body.monitor_result === "object") {
      const r = body.monitor_result;
      return {
        severity: (["none", "low", "medium", "high"].includes(r.severity) ? r.severity : "none") as ReasonSummary["severity"],
        title: typeof r.title === "string" ? r.title.slice(0, 200) : "Health check",
        summary: typeof r.summary === "string" ? r.summary.slice(0, 1000) : "Check complete.",
        findings: Array.isArray(r.findings) ? r.findings.slice(0, 10).map(String) : [],
        recommended_fix: typeof r.recommended_fix === "string" ? r.recommended_fix.slice(0, 500) : null,
        auto_fixable: r.auto_fixable === true,
      };
    }

    // If agent-reason returns a non-monitor response (mode not yet wired),
    // treat as "none" and skip to avoid false alerts.
    console.log("agent-reason did not return monitor_result — skipping", { projectId });
    return DEFAULT_SUMMARY;
  } catch (err) {
    const message = String((err as Error)?.message ?? err ?? "unknown");
    console.warn("agent-reason call threw", { projectId, message: message.slice(0, 200) });
    return {
      severity: "high",
      title: "Health check timed out or failed",
      summary: `Could not complete health check for ${domain}: ${message.slice(0, 200)}`,
      findings: [message.slice(0, 200)],
      recommended_fix: null,
      auto_fixable: false,
    };
  }
};

// ---------------------------------------------------------------------------
// Write project_risk_flags
// ---------------------------------------------------------------------------

const writeRiskFlag = async (
  projectId: string,
  severity: string,
  title: string,
  summary: string,
): Promise<void> => {
  const db = serviceDb();
  const { error } = await db.from("project_risk_flags").insert({
    project_id: projectId,
    severity,
    status: "open",
    title: title.slice(0, 200),
    summary: summary.slice(0, 2000),
  });
  if (error) {
    console.warn("Failed to write risk flag", { projectId, error: error.message });
  }
};

// ---------------------------------------------------------------------------
// Attempt auto-fix via agent-execute (cache purge first, then general fix)
// ---------------------------------------------------------------------------

const attemptAutoFix = async (projectId: string, domain: string): Promise<"succeeded" | "failed"> => {
  try {
    const url = `${FUNCTION_BASE}/functions/v1/agent-execute`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getServiceRoleKey()}`,
      },
      body: JSON.stringify({
        project_id: projectId,
        toolId: "wordpress.purge_cache",
        args: { domain },
        // Monitor auto-fix runs as service-role — no user session needed
        _monitor_mode: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok !== false) {
      console.log("Auto-fix (cache purge) succeeded", { projectId });
      return "succeeded";
    }

    console.warn("Auto-fix (cache purge) failed", { projectId, status: res.status, code: body?.code });
    return "failed";
  } catch (err) {
    console.warn("Auto-fix threw", { projectId, message: String((err as Error)?.message ?? err) });
    return "failed";
  }
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!authorized(req)) {
    return Response.json({ ok: false, code: "unauthorized", summary: "Not authorized." }, { status: 401 });
  }

  let body: MonitorRequest = {};
  try {
    if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("application/json")) {
      body = await req.json();
    }
  } catch {
    // No body — sweep all projects
  }

  const projects = await fetchProjects(body.project_id);

  if (projects.length === 0) {
    return Response.json({
      ok: true,
      monitored: 0,
      issues: [],
      errors: body.project_id ? [`Project ${body.project_id} not found or not active`] : [],
    } satisfies MonitorResult);
  }

  const issues: MonitorIssue[] = [];
  const errors: string[] = [];

  for (const project of projects) {
    try {
      const result = await callAgentReason(project.id, project.primary_domain);

      if (result.severity === "none") {
        console.log("Project healthy", { projectId: project.id, domain: project.primary_domain });
        continue;
      }

      // Always write the risk flag
      await writeRiskFlag(project.id, result.severity, result.title, result.summary);

      let action_taken: MonitorIssue["action_taken"] = "flagged";

      // Auto-fix for high severity when the agent says it's auto_fixable
      if (result.severity === "high" && result.auto_fixable) {
        action_taken = "auto_fix_attempted";
        const fixResult = await attemptAutoFix(project.id, project.primary_domain);
        action_taken = fixResult === "succeeded" ? "auto_fix_succeeded" : "auto_fix_failed";

        // Update risk flag status if fix succeeded
        if (fixResult === "succeeded") {
          const db = serviceDb();
          await db
            .from("project_risk_flags")
            .update({ status: "auto_resolved" })
            .eq("project_id", project.id)
            .eq("title", result.title)
            .eq("status", "open");
        }
      }

      issues.push({
        project_id: project.id,
        severity: result.severity,
        title: result.title,
        summary: result.summary,
        action_taken,
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err ?? "unknown");
      errors.push(`${project.id}: ${message.slice(0, 200)}`);
      console.warn("Monitor sweep error", { projectId: project.id, message });
    }
  }

  return Response.json({
    ok: true,
    monitored: projects.length,
    issues,
    errors,
  } satisfies MonitorResult, { headers: corsHeaders });
});
