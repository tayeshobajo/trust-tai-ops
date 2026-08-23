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
  checks?: string[];
};

type MonitorIssue = {
  project_id: string;
  severity: "low" | "medium" | "high";
  title: string;
  summary: string;
  action_taken: "flagged" | "queued_for_captain" | "auto_fix_attempted" | "auto_fix_succeeded" | "auto_fix_failed";
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

type ContactEventRow = {
  project_id: string;
  contacted_at: string;
};

type OutcomeRow = {
  project_id: string;
  target: string;
  outcome_data: Record<string, unknown> | null;
  created_at: string;
};

type DueFollowUpRow = {
  id: string;
  project_id: string;
  target: string;
  next_action_type: string | null;
  next_action_due_at: string | null;
  outcome_data: Record<string, unknown> | null;
};

type QueueRow = {
  id: string;
  project_id: string;
  status: string;
  created_at: string;
  digest: Record<string, unknown> | null;
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

const FOLLOWUP_LOOKAHEAD_DAYS = 30;
const PROJECT_STALE_DAYS = 5;
const QUEUE_STALE_HOURS = 24;
// Cert expiry: flag when ≤21 days remain (LE certs are 90-day; 21 gives
// a safe renewal window), high severity at ≤7 days.
const CERT_WARN_DAYS = 21;
const CERT_CRITICAL_DAYS = 7;
// Client cadence: no logged contact in 30 days = medium, 60 = high.
// Projects with ZERO contact events are reported as "no contact logged"
// (informational), not a fake-date breach.
const CADENCE_WARN_DAYS = 30;
const CADENCE_HIGH_DAYS = 60;

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

const normalizeChecks = (checks: unknown): Set<string> => {
  if (!Array.isArray(checks) || checks.length === 0) {
    return new Set(["followups", "staleness", "queue_age", "wp_health", "cert_expiry", "client_cadence"]);
  }
  return new Set(checks.filter((value): value is string => typeof value === "string").map((value) => value.trim()));
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
  const { data: existing } = await db
    .from("project_risk_flags")
    .select("id")
    .eq("project_id", projectId)
    .eq("title", title.slice(0, 200))
    .in("status", ["open", "monitoring"])
    .limit(1);
  if (existing && existing.length > 0) return;
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

const postMonitorMessage = async (projectId: string, body: string, dedupeKey: string): Promise<void> => {
  const db = serviceDb();
  const { error } = await db.from("project_messages").insert({
    project_id: projectId,
    run_id: null,
    role: "agent",
    kind: "status_update",
    body: [body],
    dedupe_key: dedupeKey,
  });
  if (error && error.code !== "23505") {
    console.warn("Failed to write monitor message", { projectId, error: error.message });
  }
};

const loadJobMeta = async (jobType: string): Promise<{ required_credentials: string[]; cloud_ready: boolean } | null> => {
  const db = serviceDb();
  const { data, error } = await db
    .from("captain_job_types")
    .select("required_credentials, cloud_ready")
    .eq("job_type", jobType)
    .eq("enabled", true)
    .maybeSingle();
  if (error || !data) return null;
  return {
    required_credentials: Array.isArray(data.required_credentials) ? data.required_credentials.map(String) : [],
    cloud_ready: data.cloud_ready === true,
  };
};

const queueCaptainJob = async (
  project: ProjectRow,
  jobType: string,
  opts: {
    taskTitle: string;
    taskSummary: string;
    memory: string[];
    dedupeDay: string; // e.g. 2026-08-23 — dedupes same-day re-queues
    extra?: Record<string, unknown>;
  },
): Promise<boolean> => {
  const db = serviceDb();
  const { data: recentRows, error: recentError } = await db
    .from("captain_plan_requests")
    .select("id, project_id, status, created_at, digest")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (!recentError && Array.isArray(recentRows) ? recentRows : []) as QueueRow[];
  const dedupeHit = rows.find((row) => {
    if (!["pending", "in_progress", "done", "approved", "executing"].includes(String(row.status))) return false;
    const digest = row.digest ?? {};
    return String(digest.jobType ?? "") === jobType &&
      String(digest.primaryDomain ?? digest.siteUrl ?? "") === project.primary_domain;
  });
  if (dedupeHit) return false;

  const jobMeta = await loadJobMeta(jobType);
  const digest = {
    taskTitle: opts.taskTitle,
    taskSummary: opts.taskSummary,
    primaryDomain: project.primary_domain,
    siteUrl: project.primary_domain,
    stack: "wordpress",
    jobType,
    requiredCredentials: jobMeta?.required_credentials ?? [],
    cloudReady: jobMeta?.cloud_ready ?? false,
    memory: opts.memory,
    constraints: [
      "This task was monitor-triggered. Plan it conservatively and require approval before any write action.",
    ],
    ...(opts.extra ?? {}),
  };

  const { error } = await db.from("captain_plan_requests").insert({
    project_id: project.id,
    run_id: null,
    digest,
    status: "pending",
  });
  if (error) {
    console.warn("Failed to queue monitor job", { projectId: project.id, jobType, error: error.message });
    return false;
  }

  await postMonitorMessage(
    project.id,
    `Monitor queued Captain planning for ${jobType} on ${project.primary_domain}. (${opts.dedupeDay})`,
    `monitor-queue-${project.id}-${jobType}-${project.primary_domain}-${opts.dedupeDay}`,
  );
  return true;
};

const queueCaptainFollowUp = async (
  project: ProjectRow,
  followUp: DueFollowUpRow,
): Promise<"queued_for_captain" | "flagged"> => {
  const jobType = typeof followUp.next_action_type === "string" && followUp.next_action_type
    ? followUp.next_action_type
    : "ops_task";
  const db = serviceDb();
  const { data: recentRows, error: recentError } = await db
    .from("captain_plan_requests")
    .select("id, project_id, status, created_at, digest")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (!recentError && Array.isArray(recentRows) ? recentRows : []) as QueueRow[];
  const dedupeHit = rows.find((row) => {
    if (!["pending", "in_progress", "done", "approved", "executing"].includes(String(row.status))) return false;
    const digest = row.digest ?? {};
    const recentEnough = Date.now() - new Date(row.created_at).getTime() < 24 * 60 * 60 * 1000;
    return recentEnough &&
      String(digest.jobType ?? "") === jobType &&
      String(digest.primaryDomain ?? digest.siteUrl ?? "") === project.primary_domain;
  });
  if (dedupeHit) return "flagged";

  const jobMeta = await loadJobMeta(jobType);
  const dueAt = followUp.next_action_due_at ?? new Date().toISOString();
  const summary =
    `Monitor detected that ${jobType} is due for ${project.primary_domain}. ` +
    `This follow-up was scheduled from an earlier Captain outcome and reached its due window on ${dueAt}.`;

  const digest = {
    taskTitle: `${jobType} for ${project.primary_domain}`,
    taskSummary: summary,
    primaryDomain: project.primary_domain,
    siteUrl: project.primary_domain,
    stack: typeof followUp.outcome_data?.stack === "string" ? followUp.outcome_data.stack : "wordpress",
    jobType,
    requiredCredentials: jobMeta?.required_credentials ?? [],
    cloudReady: jobMeta?.cloud_ready ?? false,
    memory: [
      `Triggered automatically by monitor from captain_outcomes row ${followUp.id}.`,
      `Follow-up due at ${dueAt}.`,
    ],
    constraints: [
      "This task was monitor-triggered. Plan it conservatively and require approval before any write action.",
    ],
  };

  const { error } = await db.from("captain_plan_requests").insert({
    project_id: project.id,
    run_id: null,
    digest,
    status: "pending",
  });
  if (error) {
    console.warn("Failed to queue monitor follow-up", { projectId: project.id, error: error.message });
    return "flagged";
  }

  await postMonitorMessage(
    project.id,
    `Monitor queued Captain planning for ${jobType} on ${project.primary_domain}. Follow-up reached its due window (${dueAt}).`,
    `monitor-queue-${project.id}-${jobType}-${project.primary_domain}-${dueAt.slice(0, 10)}`,
  );
  return "queued_for_captain";
};

// ---------------------------------------------------------------------------
// Cert expiry — derived from the most recent ssl_verify outcome per project.
// No synthetic data: if Captain never verified the cert, there is no expiry
// date to check, so the check is skipped (a staleness of its own is covered
// by the project-staleness check).
// ---------------------------------------------------------------------------

type CertInfo = { expiresAt: Date; issuer: string | null; domains: string[] } | null;

const parseCertInfo = (outcomeData: Record<string, unknown> | null): CertInfo => {
  if (!outcomeData) return null;
  const raw = outcomeData.cert_expiry ?? outcomeData.certExpiresAt ?? outcomeData.expires_at;
  if (typeof raw !== "string") return null;
  const expiresAt = new Date(raw);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const issuer = typeof outcomeData.cert_issuer === "string" ? outcomeData.cert_issuer : null;
  const domains = Array.isArray(outcomeData.domains_covered)
    ? outcomeData.domains_covered.map(String)
    : [];
  return { expiresAt, issuer, domains };
};

const latestSslOutcome = async (projectId: string): Promise<OutcomeRow | null> => {
  const db = serviceDb();
  const { data, error } = await db
    .from("captain_outcomes")
    .select("project_id, target, outcome_data, created_at")
    .eq("project_id", projectId)
    .in("job_type", ["ssl_verify", "ssl_install", "ssl_renew"])
    .order("created_at", { ascending: false })
    .limit(5);
  if (error || !Array.isArray(data)) return null;
  // Most recent row that actually carries a parseable expiry
  for (const row of data as OutcomeRow[]) {
    if (parseCertInfo(row.outcome_data)) return row;
  }
  return null;
};

const checkCertExpiry = async (project: ProjectRow, issues: MonitorIssue[]): Promise<void> => {
  const outcome = await latestSslOutcome(project.id);
  const cert = outcome ? parseCertInfo(outcome.outcome_data) : null;
  if (!cert) return; // nothing verified yet — skip honestly
  const daysLeft = Math.floor((cert.expiresAt.getTime() - Date.now()) / 86_400_000);
  if (daysLeft > CERT_WARN_DAYS) return;
  const severity = daysLeft <= CERT_CRITICAL_DAYS ? "high" : "medium";
  const title = `SSL certificate expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const summary = `The verified certificate for ${project.primary_domain}${cert.issuer ? ` (issued by ${cert.issuer})` : ""} expires on ${cert.expiresAt.toISOString().slice(0, 10)}. Renewal should be planned now.`;
  await writeRiskFlag(project.id, severity, title, summary);
  // Queue the renewal job when inside the warn window
  if (outcome) {
    const queued = await queueCaptainJob(project, "ssl_renew", {
      taskTitle: `SSL renewal for ${project.primary_domain}`,
      taskSummary: `Monitor detected the certificate for ${project.primary_domain} expires on ${cert.expiresAt.toISOString().slice(0, 10)} (${daysLeft} day(s) left). Plan the renewal now.`,
      memory: [
        `Triggered by cert-expiry scan from captain_outcomes row ${outcome.created_at}.`,
        `Verified issuer: ${cert.issuer ?? "unknown"}.`,
      ],
      dedupeDay: new Date().toISOString().slice(0, 10),
    });
    issues.push({
      project_id: project.id,
      severity,
      title,
      summary,
      action_taken: queued ? "queued_for_captain" : "flagged",
    });
    return;
  }
  issues.push({ project_id: project.id, severity, title, summary, action_taken: "flagged" });
};

// ---------------------------------------------------------------------------
// Client contact cadence — from durable project_contact_events rows.
// ---------------------------------------------------------------------------

const lastContactAt = async (projectId: string): Promise<ContactEventRow | null> => {
  const db = serviceDb();
  const { data, error } = await db
    .from("project_contact_events")
    .select("project_id, contacted_at")
    .eq("project_id", projectId)
    .order("contacted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as ContactEventRow;
};

const checkClientCadence = async (project: ProjectRow, issues: MonitorIssue[]): Promise<void> => {
  const last = await lastContactAt(project.id);
  if (!last) {
    // No contact ever logged — informational flag, not a fake breach.
    // Severity must be one of medium|high|critical (DB constraint).
    const title = "No client contact logged";
    const summary = `No contact event has ever been logged for ${project.primary_domain}. Log contact in Ops so cadence monitoring has a real baseline.`;
    await writeRiskFlag(project.id, "medium", title, summary);
    issues.push({ project_id: project.id, severity: "medium", title, summary, action_taken: "flagged" });
    return;
  }
  const daysSince = Math.floor((Date.now() - new Date(last.contacted_at).getTime()) / 86_400_000);
  if (daysSince < CADENCE_WARN_DAYS) return;
  const severity = daysSince >= CADENCE_HIGH_DAYS ? "high" : "medium";
  const title = `Client contact overdue (${daysSince} days)`;
  const summary = `Last logged contact for ${project.primary_domain} was ${daysSince} day(s) ago (${last.contacted_at.slice(0, 10)}). Reach out or log the contact that already happened.`;
  await writeRiskFlag(project.id, severity, title, summary);
  const queued = await queueCaptainJob(project, "client_brief_create", {
    taskTitle: `Client re-engagement for ${project.primary_domain}`,
    taskSummary: `Monitor detected no logged client contact in ${daysSince} days for ${project.primary_domain}. Draft a re-engagement touchpoint for review.`,
    memory: [
      `Triggered by client-cadence check. Last contact: ${last.contacted_at.slice(0, 10)}.`,
    ],
    dedupeDay: last.contacted_at.slice(0, 10),
  });
  issues.push({
    project_id: project.id,
    severity,
    title,
    summary,
    action_taken: queued ? "queued_for_captain" : "flagged",
  });
};

const fetchDueFollowUps = async (projectId?: string): Promise<DueFollowUpRow[]> => {
  const db = serviceDb();
  const cutoff = new Date(Date.now() + FOLLOWUP_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let query = db
    .from("captain_outcomes")
    .select("id, project_id, target, next_action_type, next_action_due_at, outcome_data")
    .not("next_action_due_at", "is", null)
    .lte("next_action_due_at", cutoff);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query;
  if (error || !data) return [];
  return data as DueFollowUpRow[];
};

const lastProjectActivityAt = async (projectId: string): Promise<string | null> => {
  const db = serviceDb();
  const [{ data: message }, { data: run }, { data: outcome }] = await Promise.all([
    db.from("project_messages").select("created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("runs").select("updated_at").eq("project_id", projectId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("captain_outcomes").select("created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return [message?.created_at, run?.updated_at, outcome?.created_at].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
};

const staleQueueAlerts = async (projectId?: string): Promise<Array<{ project_id: string; count: number; oldest: string }>> => {
  const db = serviceDb();
  const cutoff = new Date(Date.now() - QUEUE_STALE_HOURS * 60 * 60 * 1000).toISOString();
  let query = db
    .from("captain_plan_requests")
    .select("project_id, created_at, status")
    .in("status", ["pending", "in_progress", "approved", "executing"])
    .lt("created_at", cutoff);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query;
  if (error || !data) return [];
  const grouped = new Map<string, { count: number; oldest: string }>();
  for (const row of data as Array<{ project_id: string; created_at: string }>) {
    const current = grouped.get(row.project_id);
    if (!current) grouped.set(row.project_id, { count: 1, oldest: row.created_at });
    else grouped.set(row.project_id, { count: current.count + 1, oldest: current.oldest < row.created_at ? current.oldest : row.created_at });
  }
  return Array.from(grouped.entries()).map(([pid, meta]) => ({ project_id: pid, ...meta }));
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
  const checks = normalizeChecks(body.checks);

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

  if (checks.has("followups")) {
    const dueFollowUps = await fetchDueFollowUps(body.project_id);
    for (const followUp of dueFollowUps) {
      const project = projects.find((candidate) => candidate.id === followUp.project_id);
      if (!project || !followUp.next_action_type || !followUp.next_action_due_at) continue;
      const title = `Follow-up due: ${followUp.next_action_type}`;
      const summary = `${followUp.next_action_type} is due for ${project.primary_domain} on ${followUp.next_action_due_at}. Captain should plan the next step.`;
      await writeRiskFlag(project.id, "medium", title, summary);
      const action_taken = await queueCaptainFollowUp(project, followUp);
      issues.push({
        project_id: project.id,
        severity: "medium",
        title,
        summary,
        action_taken,
      });
    }
  }

  if (checks.has("cert_expiry")) {
    for (const project of projects) {
      try {
        await checkCertExpiry(project, issues);
      } catch (err) {
        errors.push(`${project.id}: cert_expiry: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      }
    }
  }

  if (checks.has("client_cadence")) {
    for (const project of projects) {
      try {
        await checkClientCadence(project, issues);
      } catch (err) {
        errors.push(`${project.id}: client_cadence: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      }
    }
  }

  if (checks.has("queue_age")) {
    const staleQueue = await staleQueueAlerts(body.project_id);
    for (const stalled of staleQueue) {
      const project = projects.find((candidate) => candidate.id === stalled.project_id);
      if (!project) continue;
      const title = "Captain queue stalled";
      const summary = `${stalled.count} Captain queue item(s) have been waiting since ${stalled.oldest} on ${project.primary_domain}.`;
      await writeRiskFlag(project.id, "high", title, summary);
      await postMonitorMessage(
        project.id,
        `Monitor flagged a stalled Captain queue on ${project.primary_domain}. ${stalled.count} item(s) have been waiting since ${stalled.oldest}.`,
        `monitor-queue-age-${project.id}-${stalled.oldest.slice(0, 13)}`,
      );
      issues.push({
        project_id: project.id,
        severity: "high",
        title,
        summary,
        action_taken: "flagged",
      });
    }
  }

  for (const project of projects) {
    try {
      if (checks.has("staleness")) {
        const lastActivity = await lastProjectActivityAt(project.id);
        if (lastActivity) {
          const staleMs = Date.now() - new Date(lastActivity).getTime();
          if (staleMs > PROJECT_STALE_DAYS * 24 * 60 * 60 * 1000) {
            const title = "Project activity stale";
            const summary = `${project.primary_domain} has had no recorded Ops activity in ${Math.floor(staleMs / (24 * 60 * 60 * 1000))} day(s).`;
            await writeRiskFlag(project.id, "medium", title, summary);
            issues.push({
              project_id: project.id,
              severity: "medium",
              title,
              summary,
              action_taken: "flagged",
            });
          }
        }
      }

      if (!checks.has("wp_health")) continue;
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
            .update({ status: "resolved" })
            .eq("project_id", project.id)
            .eq("title", result.title)
            .eq("status", "open");
        }
      } else if (result.severity === "high" || (result.severity === "medium" && result.recommended_fix)) {
        // Brief: "wire to job queue" — any real medium/high wp_health finding
        // with a recommended fix gets a Captain plan request instead of only a
        // passive flag. Deduped by jobType+domain in queueCaptainJob.
        const queued = await queueCaptainJob(project, "wp_debug_fix", {
          taskTitle: `${result.title} on ${project.primary_domain}`,
          taskSummary: `Monitor health check found: ${result.summary} Recommended fix: ${result.recommended_fix ?? "diagnose first"}.`,
          memory: [
            `Triggered by wp_health scan at ${new Date().toISOString()}.`,
            `Severity: ${result.severity}. Findings: ${result.findings.join("; ").slice(0, 500)}`,
          ],
          dedupeDay: new Date().toISOString().slice(0, 10),
          extra: { findings: result.findings },
        });
        if (queued) action_taken = "queued_for_captain";
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
