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
  reason(projectId: string, digest: Record<string, unknown>): Promise<unknown | null>;
  /**
   * Server truth about which private capabilities this project can actually
   * use, split into stored and verified. Client-side access state is only ever
   * a hint, and "stored" is never presented to a person as "verified".
   */
  projectCapabilities(projectId: string): Promise<ProjectCapabilities>;
}

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

  async reason(projectId: string, digest: Record<string, unknown>): Promise<unknown | null> {
    if (!this.available()) return null;
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-reason", {
        body: { projectId, digest, model: readReasonModelId() },
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

}

let gateway: ExecutionGateway = new SupabaseFunctionGateway();

export const executionGateway = (): ExecutionGateway => gateway;

/** Test seam. Not used by the application. */
export const setExecutionGateway = (next: ExecutionGateway) => {
  gateway = next;
};
