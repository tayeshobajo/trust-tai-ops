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

export interface ExecutionGateway {
  available(): boolean;
  invoke(request: GatewayRequest): Promise<GatewayResponse>;
  /**
   * Server truth about which private capabilities this project can actually
   * use. Client-side access state is only ever a hint.
   */
  confirmedCapabilities(projectId: string): Promise<string[]>;
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

  async confirmedCapabilities(projectId: string): Promise<string[]> {
    if (!this.available()) return [];
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke("agent-execute", {
        body: { mode: "capabilities", projectId },
      });
      if (error) return [];
      const payload = data as { ok?: boolean; data?: { capabilities?: unknown } } | null;
      if (!payload?.ok || !Array.isArray(payload.data?.capabilities)) return [];
      return (payload.data?.capabilities as unknown[]).filter(
        (value): value is string => typeof value === "string",
      );
    } catch {
      // Unproven means unavailable. Never assume a capability exists.
      return [];
    }
  }
}

let gateway: ExecutionGateway = new SupabaseFunctionGateway();

export const executionGateway = (): ExecutionGateway => gateway;

/** Test seam. Not used by the application. */
export const setExecutionGateway = (next: ExecutionGateway) => {
  gateway = next;
};
