/**
 * Execution boundary.
 *
 * The browser never performs a privileged operation and never holds a
 * credential. It sends an identity (project, run, action) to a server-side
 * execution gateway, which resolves the real execution context there.
 *
 * Today the gateway is a Supabase Edge Function (`supabase/functions/agent-execute`).
 * When it is not deployed or not configured, every call returns a truthful
 * `execution_backend_unavailable` result. Nothing is ever simulated.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "../env";
import { getSupabaseClient } from "../supabase";
import { readReasonModelId } from "./reasonModels";
import type { AgentActionArguments, ToolFailureCode, ToolId } from "./types";

export type GatewayRequest = {
  projectId: string;
  runId: string | null;
  actionId: string;
  toolId: ToolId;
  invocationKey: string;
  /** Safe payload only. Never credentials, never arbitrary code. */
  args: AgentActionArguments;
};

export type GatewayResponse =
  | { ok: true; summary: string; data: Record<string, unknown> }
  | { ok: false; code: ToolFailureCode; summary: string; retryable: boolean };

export type ProjectCapabilities = {
  /** A credential exists for this project and the server can decrypt it. */
  stored: string[];
  /** The provider has actually accepted that credential at least once. */
  verified: string[];
};

export interface ExecutionGateway {
  available(): boolean;
  invoke(request: GatewayRequest): Promise<GatewayResponse>;
  /**
   * Asks the server-side reasoner what should happen next. Returns null
   * whenever reasoning is unavailable, refused, or unsafe — never a guess.
   */
  reason(projectId: string, digest: Record<string, unknown>, runId?: string | null): Promise<unknown | null>;
  /**
   * Server truth about which private capabilities this project can actually
   * use, split into stored and verified. Client-side access state is only ever
   * a hint, and "stored" is never presented to a person as "verified".
   */
  projectCapabilities(projectId: string): Promise<ProjectCapabilities>;
  /**
   * Diagnosis synthesis: all evidence in, causal chains out. Returns null on
   * any failure — the synthesis is an enhancement, never a dependency.
   */
  synthesize(projectId: string, digest: Record<string, unknown>): Promise<{ ok: boolean; synthesis?: string } | null>;
  /**
   * Fix-plan: given evidence + diagnosis, returns an ordered set of write steps.
   * Returns null on failure — enhancement only, never a dependency.
   */
  planFix(projectId: string, digest: Record<string, unknown>): Promise<FixPlanResult | null>;
  /**
   * Captain plan: submits a client task to Captain for inspection-first
   * planning. Returns a structured plan with flags, prerequisites, and ordered
   * steps. Rendered in chat with an Approve gate — nothing executes until approved.
   */
  captainPlan(projectId: string, digest: Record<string, unknown>): Promise<CaptainPlanResult | null>;

  /**
   * Record a successfully resolved task as a knowledge base pattern.
   * Fire-and-forget — never throws, never blocks the caller.
   */
  recordResolution(params: {
    projectId: string;
    runId: string;
    taskType: string;
    taskTitle: string;
    hostContext: string | null;
  }): Promise<void>;
}

export type FixStep = {
  stepId: string;
  toolId: string;
  label: string;
  args: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  backupFirst: boolean;
  requiresConfirmation: boolean;
  /** Optional before/after diff the reasoner inferred from evidence. */
  preview?: {
    target: string;
    before: string;
    after: string;
    irreversible?: string;
  };
};

export type FixPlanResult = {
  rationale: string;
  risk: "low" | "medium" | "high";
  steps: FixStep[];
  verificationGoal: string;
  canAutoExecute: boolean;
};

export type CaptainPlanStep = {
  label: string;
  detail: string;
  risk: "low" | "medium" | "high";
  requiresCredential?: string;
};

export type CaptainPlanResult = {
  rationale: string;
  flags: string[];
  prerequisites: string[];
  steps: CaptainPlanStep[];
  verificationGoal: string;
  risk: "low" | "medium" | "high";
  readyToExecute: boolean;
};

const UNAVAILABLE: GatewayResponse = {
  ok: false,
  code: "execution_backend_unavailable",
  summary: "I can't reach the checking service from here yet, so I have nothing verified to report.",
  retryable: true,
};

class SupabaseFunctionGateway implements ExecutionGateway {
  available(): boolean {
    return hasSupabasePublicConfig(resolveOpsEnv());
  }

  async invoke(request: GatewayRequest): Promise<GatewayResponse> {
    if (!this.available()) return UNAVAILABLE;

    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-execute", { body: request });
      if (error) return UNAVAILABLE;
      const payload = data as GatewayResponse | null;
      if (!payload || typeof payload !== "object" || typeof (payload as { ok?: unknown }).ok !== "boolean") {
        return UNAVAILABLE;
      }
      return payload;
    } catch {
      // Never surface a transport error verbatim: it can carry URLs and headers.
      return UNAVAILABLE;
    }
  }

  async projectCapabilities(projectId: string): Promise<ProjectCapabilities> {
    const none: ProjectCapabilities = { stored: [], verified: [] };
    if (!this.available()) return none;
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-execute", {
        body: { mode: "capabilities", projectId },
      });
      if (error) return none;
      const payload = data as
        | { ok?: boolean; data?: { capabilities?: unknown; verifiedCapabilities?: unknown } }
        | null;
      if (!payload?.ok) return none;
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      return {
        stored: strings(payload.data?.capabilities),
        verified: strings(payload.data?.verifiedCapabilities),
      };
    } catch {
      // Unproven means unavailable. Never assume a capability exists.
      return none;
    }
  }

  async reason(projectId: string, digest: Record<string, unknown>, runId?: string | null): Promise<unknown | null> {
    if (!this.available()) return null;
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-reason", {
        // The run id is a claim; the server proves it belongs to this project
        // before it loads a single attachment against it.
        body: { projectId, digest, runId: runId ?? null, model: readReasonModelId() },
      });
      if (error) return null;
      const payload = data as { ok?: boolean; plan?: unknown } | null;
      if (!payload?.ok || !payload.plan) return null;
      return payload.plan;
    } catch {
      // Reasoning is an enhancement, never a dependency.
      return null;
    }
  }

  async synthesize(
    projectId: string,
    digest: Record<string, unknown>,
  ): Promise<{ ok: boolean; synthesis?: string } | null> {
    if (!this.available()) return null;
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-reason", {
        body: { projectId, mode: "synthesize_diagnosis", digest, model: readReasonModelId() },
      });
      if (error) return null;
      const payload = data as { ok?: boolean; synthesis?: unknown } | null;
      if (!payload || typeof payload.ok !== "boolean") return null;
      if (!payload.ok || typeof payload.synthesis !== "string") return { ok: false };
      return { ok: true, synthesis: payload.synthesis };
    } catch {
      return null;
    }
  }

  async planFix(
    projectId: string,
    digest: Record<string, unknown>,
  ): Promise<FixPlanResult | null> {
    if (!this.available()) return null;
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-reason", {
        body: { projectId, mode: "plan_fix", digest, model: readReasonModelId() },
      });
      if (error) return null;
      const payload = data as { ok?: boolean; fix_plan?: unknown } | null;
      if (!payload?.ok || !payload.fix_plan || typeof payload.fix_plan !== "object") return null;
      const fp = payload.fix_plan as Record<string, unknown>;
      // Validate the minimum shape before returning.
      if (!Array.isArray(fp.steps) || fp.steps.length === 0) return null;
      return payload.fix_plan as FixPlanResult;
    } catch {
      // Fix planning is an enhancement, never a dependency.
      return null;
    }
  }

  async captainPlan(
    projectId: string,
    digest: Record<string, unknown>,
  ): Promise<CaptainPlanResult | null> {
    if (!this.available()) return null;
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-reason", {
        body: { projectId, mode: "captain_plan", digest, model: readReasonModelId() },
      });
      if (error) return null;
      const payload = data as { ok?: boolean; captain_plan?: unknown } | null;
      if (!payload?.ok || !payload.captain_plan || typeof payload.captain_plan !== "object") return null;
      const cp = payload.captain_plan as Record<string, unknown>;
      if (!Array.isArray(cp.steps) || cp.steps.length === 0) return null;
      return payload.captain_plan as CaptainPlanResult;
    } catch {
      return null;
    }
  }

  /**
   * Fire-and-forget: record a resolved task as a knowledge base pattern.
   * Never throws, never blocks the UI.
   */
  async recordResolution(params: {
    projectId: string;
    runId: string;
    taskType: string;
    taskTitle: string;
    hostContext: string | null;
  }): Promise<void> {
    if (!this.available()) return;
    try {
      const client = getSupabaseClient();
      await client.functions.invoke("agent-reason", {
        body: {
          projectId: params.projectId,
          mode: "record_resolution",
          runId: params.runId,
          taskType: params.taskType,
          taskTitle: params.taskTitle,
          hostContext: params.hostContext ?? null,
          model: readReasonModelId(),
        },
      });
    } catch {
      // Non-fatal: learning is an enhancement, not a dependency.
    }
  }

}

let gateway: ExecutionGateway = new SupabaseFunctionGateway();

export const executionGateway = (): ExecutionGateway => gateway;

/** Test seam. Not used by the application. */
export const setExecutionGateway = (next: ExecutionGateway) => {
  gateway = next;
};
