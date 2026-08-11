/**
 * Agent orchestrator.
 *
 * Decides (reasoner) -> checks policy -> executes real tools with idempotency
 * -> records audit events -> grounds what the agent says in evidence.
 *
 * The workspace never talks to tools, policy or the gateway directly.
 */

import type { AccessType, MemoryEntry, Organization, NewProjectMessage, Project, ProjectMessage, Run } from "../types";
import { workspaceRepository } from "../repository";
import {
  describeHealth,
  describeErrorLog,
  describePageInspection,
  describePlugins,
  describePublicSurface,
  describeSiteInspection,
  findingFromEvidence,
} from "./evidence";
import { evaluateAction } from "./policy";
import { getTool } from "./registry";
import { executionGateway } from "./gateway";
import { safeSummary } from "./safety";
import { selectReasoner, type AgentReasoner } from "./reasoner";
import {
  MAX_ACTION_RETRIES,
  MAX_AGENT_ITERATIONS,
  MAX_AGENT_WALL_CLOCK_MS,
  MAX_ITERATIONS_WITHOUT_PROGRESS,
} from "./budgets";
import type {
  AgentAction,
  AgentContext,
  AgentEvidence,
  AgentStopReason,
  AgentTurnResult,
  Capability,
  ExecutionEvent,
  ToolFailureCode,
} from "./types";

export type OrchestratorInput = {
  project: Project;
  run: Run;
  recentMessages: ProjectMessage[];
  memory: MemoryEntry[];
  emit: (message: NewProjectMessage) => Promise<ProjectMessage | null>;
  onWorkspaceUpdate: (next: Organization) => void;
  reasoner?: AgentReasoner;
};

const ACCESS_LABELS: Record<AccessType, string> = {
  wordpress_admin: "WordPress admin",
  sftp: "SFTP/FTP",
  ssh: "SSH",
  hosting_portal: "hosting",
  database: "database",
  cdn: "CDN",
  server_pm2: "server process manager",
  ci_cd: "CI/CD pipeline",
  container: "container platform",
};

const primaryUrlFor = (project: Project, run: Run): string | null => {
  const environment =
    project.environments.find((item) => item.id === run.environmentId) ?? project.environments[0] ?? null;
  const raw = environment?.primaryUrl || (project.primaryDomain ? `https://${project.primaryDomain}` : "");
  return raw ? raw : null;
};

/**
 * Client-side hint only. Useful for what the workspace shows a person, never
 * sufficient to run a private tool.
 */
export const capabilitiesFor = (project: Project): Capability[] => [
  "public_internet",
  ...project.accessMethods.filter((method) => method.status === "available").map((method) => method.type),
];

/** Tools that can only run with a stored private credential. */
const PRIVATE_TOOLS = new Set<string>(["wordpress.list_plugins"]);

/**
 * Server truth, in two grades.
 *
 *   stored   — the gateway can decrypt a credential belonging to this project.
 *              Enough to *attempt* a read-only private call.
 *   verified — the provider has already accepted that credential. The only
 *              grade that may ever be described to a person as verified.
 *
 * An `available` access record is a claim the browser makes, and the browser
 * is not trusted for either grade.
 */
const serverCapabilities = async (
  project: Project,
): Promise<{ capabilities: Capability[]; verified: Capability[] }> => {
  const base: Capability[] = ["public_internet"];
  try {
    const truth = await executionGateway().projectCapabilities(project.id);
    const known = new Set(project.accessMethods.map((method) => method.type as string));
    const keep = (values: string[]): Capability[] =>
      values.filter((value): value is Capability => known.has(value) || value === "wordpress_admin");
    return { capabilities: [...base, ...keep(truth.stored)], verified: keep(truth.verified) };
  } catch {
    return { capabilities: base, verified: [] };
  }
};

/**
 * Prior observations, reconstructed from the audit trail of this run: what was
 * genuinely learned, and what already proved impossible. Both matter — an
 * agent that forgets its failures loops forever.
 */
const loadPriorObservations = async (
  projectId: string,
  runId: string,
): Promise<{ evidence: AgentEvidence[]; failed: Array<{ toolId: AgentEvidence["toolId"]; code: ToolFailureCode }> }> => {
  try {
    const events = await workspaceRepository.listExecutionEvents(projectId, runId);
    return {
      evidence: events
        .filter((event) => event.status === "succeeded")
        .map((event) => ({
          id: `${event.invocationKey}:evidence`,
          toolId: event.toolId,
          summary: event.outputSummary,
          data: (event.evidenceData ?? {}) as Record<string, unknown>,
          sensitivity: "public" as const,
          redacted: true,
          observedAt: event.finishedAt ?? event.startedAt,
        })),
      failed: events
        .filter((event) => event.status === "failed" && event.errorCode)
        .map((event) => ({ toolId: event.toolId, code: event.errorCode as ToolFailureCode })),
    };
  } catch {
    return { evidence: [], failed: [] };
  }
};

export const buildAgentContext = async (input: OrchestratorInput): Promise<AgentContext> => {
  const { project, run } = input;
  const capabilities = await serverCapabilities(project);
  const observations = await loadPriorObservations(project.id, run.id);
  return {
    project,
    run,
    recentMessages: input.recentMessages.slice(-20),
    memory: input.memory,
    capabilities: capabilities.capabilities,
    verifiedCapabilities: capabilities.verified,
    evidence: observations.evidence,
    failedObservations: observations.failed,
    environment: {
      primaryUrl: primaryUrlFor(project, run),
      executionBackendAvailable: executionGateway().available(),
    },
  };
};

const say = async (input: OrchestratorInput, key: string, lines: string[]) => {
  const body = lines.map((line) => safeSummary(line, 400)).filter((line) => line.length > 0);
  if (body.length === 0) return;
  await input.emit({
    runId: input.run.id,
    role: "agent",
    kind: "status_update",
    body,
    dedupeKey: `exec-${input.run.id}-${key}`,
  });
};

const recordEvent = async (
  projectId: string,
  event: Omit<ExecutionEvent, "id">,
): Promise<void> => {
  try {
    await workspaceRepository.saveExecutionEvent(projectId, event);
  } catch {
    // The audit trail must never break the conversation. A missing record only
    // means the next replay re-runs a read-only check.
  }
};

const describe = (evidence: AgentEvidence): string[] => {
  switch (evidence.toolId) {
    case "public_http.inspect_site":
      return describeSiteInspection(evidence);
    case "wordpress.inspect_public_surface":
      return describePublicSurface(evidence);
    case "wordpress.read_health":
      return describeHealth(evidence);
    case "wordpress.list_plugins":
      return describePlugins(evidence);
    case "wordpress.read_error_log":
      return describeErrorLog(evidence);
    case "browser.inspect_page_readonly":
      return describePageInspection(evidence);
    default:
      return [evidence.summary];
  }
};

export type ActionOutcome =
  | { kind: "evidence"; evidence: AgentEvidence[] }
  | { kind: "blocked"; requires: "access" | "backup" | "approval" | "backend"; reason: string }
  | { kind: "failed"; code: ToolFailureCode; retryable: boolean }
  | { kind: "in_flight" };

/** Executes one action, reusing a completed invocation when replayed. */
const executeAction = async (
  input: OrchestratorInput,
  context: AgentContext,
  action: AgentAction,
): Promise<ActionOutcome> => {
  const { project, run } = input;
  const verdict = evaluateAction(action, context);
  const startedAt = new Date().toISOString();

  if (!verdict.executable) {
    await recordEvent(project.id, {
      projectId: project.id,
      runId: run.id,
      toolId: action.toolId,
      invocationKey: action.invocationKey,
      status: "blocked",
      risk: action.risk,
      startedAt,
      finishedAt: startedAt,
      inputSummary: safeSummary(action.purpose),
      outputSummary: safeSummary(verdict.reason),
      errorCode: "blocked_by_policy",
      evidenceRefs: [],
    });
    return { kind: "blocked", requires: verdict.requires, reason: verdict.reason };
  }

  // Idempotency: the same planned action, replayed, reuses its result.
  let existing: ExecutionEvent | null = null;
  try {
    existing = await workspaceRepository.findExecutionEvent(project.id, action.invocationKey);
  } catch {
    existing = null;
  }
  if (existing && existing.status === "succeeded" && !action.refreshable) {
    return {
      kind: "evidence",
      evidence: [
      {
        id: `${existing.invocationKey}:evidence`,
        toolId: existing.toolId,
        summary: existing.outputSummary,
        data: (existing.evidenceData ?? {}) as Record<string, unknown>,
        sensitivity: "public",
        redacted: true,
        observedAt: existing.finishedAt ?? existing.startedAt,
      },
      ],
    };
  }
  if (existing && existing.status === "running") return { kind: "in_flight" };

  await recordEvent(project.id, {
    projectId: project.id,
    runId: run.id,
    toolId: action.toolId,
    invocationKey: action.invocationKey,
    status: "running",
    risk: action.risk,
    startedAt,
    finishedAt: null,
    inputSummary: safeSummary(action.purpose),
    outputSummary: "",
    errorCode: null,
    evidenceRefs: [],
  });

  const result = await getTool(action.toolId).execute(action, project.id, run.id);
  const finishedAt = new Date().toISOString();

  if (!result.ok) {
    await recordEvent(project.id, {
      projectId: project.id,
      runId: run.id,
      toolId: action.toolId,
      invocationKey: action.invocationKey,
      status: "failed",
      risk: action.risk,
      startedAt,
      finishedAt,
      inputSummary: safeSummary(action.purpose),
      outputSummary: safeSummary(result.summary),
      errorCode: result.code,
      evidenceRefs: [],
    });
    // A failure is a real observation and is reported as one.
    await say(input, `fail-${action.invocationKey}`, [result.summary]);
    return { kind: "failed", code: result.code, retryable: result.retryable };
  }

  await recordEvent(project.id, {
    projectId: project.id,
    runId: run.id,
    toolId: action.toolId,
    invocationKey: action.invocationKey,
    status: "succeeded",
    risk: action.risk,
    startedAt,
    finishedAt,
    inputSummary: safeSummary(action.purpose),
    outputSummary: safeSummary(result.summary),
    errorCode: null,
    evidenceRefs: result.evidence.map((item) => item.id),
    evidenceData: result.evidence[0]?.data ?? {},
  });

  return { kind: "evidence", evidence: result.evidence };
};

/**
 * One agent turn: a bounded, iterative investigation.
 *
 * The agent reasons, performs *one* read-only observation, folds what it
 * observed back into its context, and reasons again — until it has enough,
 * until it needs a human, or until a budget stops it. It is autonomous about
 * reads and never about changes: a non-read-only action stops the loop and
 * waits for a person, it is never executed here.
 */
export const runAgentTurn = async (input: OrchestratorInput): Promise<AgentTurnResult> => {
  let context = await buildAgentContext(input);
  const reasoner = input.reasoner ?? selectReasoner();

  const learned: AgentEvidence[] = [];
  const spoke: string[] = [];
  const attempted = new Map<string, number>();
  const startedAt = Date.now();

  const alreadyVerified = (context.verifiedCapabilities ?? []).includes("wordpress_admin");
  let announcedStoredAccess = false;
  let iterations = 0;
  let stallCount = 0;
  let usedStoredAccess = false;
  let awaiting: AgentTurnResult["awaiting"] = null;
  let stopReason: AgentStopReason = "safe_stop";

  while (iterations < MAX_AGENT_ITERATIONS) {
    if (Date.now() - startedAt > MAX_AGENT_WALL_CLOCK_MS) {
      stopReason = "budget_exhausted";
      break;
    }
    iterations += 1;

    const plan = await reasoner.plan(context);
    if (!plan) {
      stopReason = learned.length > 0 ? "sufficient_evidence" : "safe_stop";
      break;
    }

    if (plan.decision.intent === "request_access") {
      const requested = plan.decision.requestedAccess ?? [];
      const wordpressOnly = requested.length === 1 && requested[0] === "wordpress_admin";
      const lines =
        plan.decision.message ??
        (wordpressOnly
          ? [
              "I can see this is WordPress. To inspect the installed plugins and the private health checks, I need WordPress Admin access. An Application Password is the safest option — it can be revoked on its own and I never need your login password.",
            ]
          : [
              requested.length > 0
                ? `To go further than the public checks I'd need ${requested
                    .map((type) => ACCESS_LABELS[type])
                    .join(" or ")} access. Everything I've said so far is only what I could see from outside.`
                : "I've gone as far as the public checks allow.",
            ]);
      await say(input, `access-${requested.join("-") || "none"}`, lines);
      spoke.push(...lines);
      awaiting = "access";
      stopReason = "needs_access";
      break;
    }

    // One observation per iteration, and never the same one twice.
    const action = plan.actions.find((candidate) => !attempted.has(candidate.invocationKey)) ?? null;

    if (!action) {
      if (plan.decision.message && plan.decision.message.length > 0) {
        await say(input, `note-${plan.decision.intent}`, plan.decision.message);
        spoke.push(...plan.decision.message);
      }
      if (plan.decision.intent === "await_human_decision") stopReason = "needs_user_input";
      else stopReason = learned.length > 0 ? "sufficient_evidence" : "safe_stop";
      break;
    }

    // The autonomy line. A change is proposed to a person; it is not performed.
    if (!action.readOnly) {
      awaiting = "approval";
      stopReason = "approval_required";
      break;
    }

    // Stored is not verified. If the agent is about to lean on a stored
    // credential that WordPress has never accepted, the person is told first.
    if (
      PRIVATE_TOOLS.has(action.toolId) &&
      !alreadyVerified &&
      !announcedStoredAccess &&
      context.capabilities.includes("wordpress_admin")
    ) {
      announcedStoredAccess = true;
      const lines = [
        "WordPress Admin access is stored securely. I'm verifying it with a read-only check before I use it.",
      ];
      await say(input, `verifying-access-${input.run.id}`, lines);
      spoke.push(...lines);
    }
    if (PRIVATE_TOOLS.has(action.toolId)) usedStoredAccess = true;

    const attempts = attempted.get(action.invocationKey) ?? 0;
    attempted.set(action.invocationKey, attempts + 1);

    const outcome = await executeAction(input, context, action);

    if (outcome.kind === "blocked") {
      if (outcome.requires === "access") {
        awaiting = "access";
        stopReason = "needs_access";
      } else if (outcome.requires === "backup" || outcome.requires === "approval") {
        awaiting = outcome.requires;
        stopReason = "approval_required";
      } else {
        stopReason = "tool_unavailable";
      }
      break;
    }

    if (outcome.kind === "in_flight") {
      stopReason = "safe_stop";
      break;
    }

    if (outcome.kind === "failed") {
      // A retryable failure earns one more attempt; anything else becomes a
      // remembered dead end so the next iteration chooses differently.
      if (outcome.retryable && attempts < MAX_ACTION_RETRIES) {
        attempted.delete(action.invocationKey);
        attempted.set(`${action.invocationKey}:retried`, 1);
      }
      context = {
        ...context,
        failedObservations: [...(context.failedObservations ?? []), { toolId: action.toolId, code: outcome.code }],
      };
      stallCount += 1;
      if (stallCount >= MAX_ITERATIONS_WITHOUT_PROGRESS) {
        stopReason = outcome.code === "tool_unavailable" || outcome.code === "not_implemented"
          ? "tool_unavailable"
          : "safe_stop";
        break;
      }
      continue;
    }

    stallCount = 0;
    for (const item of outcome.evidence) {
      learned.push(item);
      const lines = describe(item);
      spoke.push(...lines);
      await say(input, item.id, lines);

      const finding = findingFromEvidence(item);
      if (finding) {
        try {
          const next = await workspaceRepository.addEvidence(
            input.project.id,
            input.run.id,
            "scan_result",
            finding.title,
            finding.summary,
          );
          input.onWorkspaceUpdate(next);
        } catch {
          // Evidence storage failing must not rewrite what was observed.
        }
      }
    }

    // What was just observed becomes the basis for the next decision.
    context = { ...context, evidence: [...context.evidence, ...outcome.evidence] };

    if (outcome.evidence.length === 0) {
      stallCount += 1;
      if (stallCount >= MAX_ITERATIONS_WITHOUT_PROGRESS) {
        stopReason = "safe_stop";
        break;
      }
    }
  }

  if (iterations >= MAX_AGENT_ITERATIONS && stopReason === "safe_stop") {
    stopReason = "budget_exhausted";
  }

  if (usedStoredAccess && !alreadyVerified && learned.some((item) => PRIVATE_TOOLS.has(item.toolId))) {
    const lines = [
      "Access verified. I can now inspect the private WordPress health signals and installed plugins without changing anything.",
    ];
    await say(input, `access-verified-${input.run.id}`, lines);
    spoke.push(...lines);
  }

  return {
    learned,
    acted: learned.length > 0 || spoke.length > 0,
    awaiting,
    stopReason,
    iterations,
    spoke,
  };
};
