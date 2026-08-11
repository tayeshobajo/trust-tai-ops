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
import type {
  AgentAction,
  AgentContext,
  AgentEvidence,
  AgentTurnResult,
  Capability,
  ExecutionEvent,
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

/** Prior evidence, reconstructed from the audit trail of this run. */
const loadPriorEvidence = async (projectId: string, runId: string): Promise<AgentEvidence[]> => {
  try {
    const events = await workspaceRepository.listExecutionEvents(projectId, runId);
    return events
      .filter((event) => event.status === "succeeded")
      .map((event) => ({
        id: `${event.invocationKey}:evidence`,
        toolId: event.toolId,
        summary: event.outputSummary,
        data: (event.evidenceData ?? {}) as Record<string, unknown>,
        sensitivity: "public" as const,
        redacted: true,
        observedAt: event.finishedAt ?? event.startedAt,
      }));
  } catch {
    return [];
  }
};

export const buildAgentContext = async (input: OrchestratorInput): Promise<AgentContext> => {
  const { project, run } = input;
  const capabilities = await serverCapabilities(project);
  return {
    project,
    run,
    recentMessages: input.recentMessages.slice(-20),
    memory: input.memory,
    capabilities: capabilities.capabilities,
    verifiedCapabilities: capabilities.verified,
    evidence: await loadPriorEvidence(project.id, run.id),
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
    default:
      return [evidence.summary];
  }
};

/** Executes one action, reusing a completed invocation when replayed. */
const executeAction = async (
  input: OrchestratorInput,
  context: AgentContext,
  action: AgentAction,
): Promise<AgentEvidence[]> => {
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
    return [];
  }

  // Idempotency: the same planned action, replayed, reuses its result.
  let existing: ExecutionEvent | null = null;
  try {
    existing = await workspaceRepository.findExecutionEvent(project.id, action.invocationKey);
  } catch {
    existing = null;
  }
  if (existing && existing.status === "succeeded" && !action.refreshable) {
    return [
      {
        id: `${existing.invocationKey}:evidence`,
        toolId: existing.toolId,
        summary: existing.outputSummary,
        data: (existing.evidenceData ?? {}) as Record<string, unknown>,
        sensitivity: "public",
        redacted: true,
        observedAt: existing.finishedAt ?? existing.startedAt,
      },
    ];
  }
  if (existing && existing.status === "running") return [];

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
    return [];
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

  return result.evidence;
};

/**
 * One agent turn. Returns what was learned and what, if anything, the human
 * now needs to do.
 */
export const runAgentTurn = async (input: OrchestratorInput): Promise<AgentTurnResult> => {
  const context = await buildAgentContext(input);
  const reasoner = input.reasoner ?? selectReasoner();
  const plan = await reasoner.plan(context);

  if (!plan) return { learned: [], acted: false, awaiting: null, spoke: [] };

  const learned: AgentEvidence[] = [];
  const spoke: string[] = [];

  // Stored is not verified. If this turn is about to lean on a stored
  // credential that WordPress has never accepted, the person is told exactly
  // that before it is used — and told again once it is proven.
  const usesStoredAccess = plan.actions.some((action) => PRIVATE_TOOLS.has(action.toolId));
  const alreadyVerified = (context.verifiedCapabilities ?? []).includes("wordpress_admin");
  if (usesStoredAccess && !alreadyVerified && context.capabilities.includes("wordpress_admin")) {
    const lines = [
      "WordPress Admin access is stored securely. I'm verifying it with a read-only check before I use it.",
    ];
    await say(input, `verifying-access-${input.run.id}`, lines);
    spoke.push(...lines);
  }

  for (const action of plan.actions) {
    const evidence = await executeAction(input, context, action);
    for (const item of evidence) {
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
  }

  if (usesStoredAccess && !alreadyVerified && learned.some((item) => PRIVATE_TOOLS.has(item.toolId))) {
    const lines = [
      "Access verified. I can now inspect the private WordPress health signals and installed plugins without changing anything.",
    ];
    await say(input, `access-verified-${input.run.id}`, lines);
    spoke.push(...lines);
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
    return { learned, acted: true, awaiting: "access", spoke };
  }

  if (plan.decision.message && plan.actions.length === 0) {
    await say(input, `note-${plan.decision.intent}`, plan.decision.message);
    spoke.push(...plan.decision.message);
    return { learned, acted: true, awaiting: null, spoke };
  }

  return { learned, acted: learned.length > 0 || spoke.length > 0, awaiting: null, spoke };
};
