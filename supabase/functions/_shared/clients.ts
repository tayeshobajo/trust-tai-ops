/**
 * Supabase clients for edge functions. The only file with npm imports, so the
 * rest of the shared logic stays runtime-agnostic and testable.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import type { AuthzDeps } from "./authz.ts";
import type { SecretStoreDeps, StoredSecretRow } from "./secretStore.ts";

const url = () => Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = () => Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export const executionContextConfigured = (): boolean =>
  Boolean(url() && anonKey() && serviceKey());

export const serviceClient = () =>
  createClient(url(), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

export const authzDeps = (): AuthzDeps => {
  const service = serviceClient();
  const anon = createClient(url(), anonKey(), { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    verifyToken: async (token) => {
      const { data, error } = await anon.auth.getClaims(token);
      const claims = data?.claims as Record<string, unknown> | undefined;
      if (error || !claims?.sub) return null;
      return { userId: String(claims.sub), email: String(claims.email ?? "").toLowerCase() };
    },
    loadProject: async (projectId) => {
      const { data } = await service
        .from("projects")
        .select("id, organization_id, primary_domain")
        .eq("id", projectId)
        .maybeSingle();
      if (!data) return null;
      return {
        id: String(data.id),
        organizationId: String(data.organization_id),
        primaryDomain: String(data.primary_domain ?? ""),
      };
    },
    loadMembership: async (email) => {
      const { data } = await service
        .from("users")
        .select("organization_id, status")
        .ilike("email", email)
        .maybeSingle();
      if (!data || (data.status && data.status === "disabled")) return null;
      return { organizationId: String(data.organization_id) };
    },
    // Preferred path. Falls back to email only when the column is absent
    // (older schema) or the row has not been bound to an auth UID yet.
    loadMembershipByAuthId: async (authUserId) => {
      const { data, error } = await service
        .from("users")
        .select("organization_id, status")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (error || !data || data.status === "disabled") return null;
      return { organizationId: String(data.organization_id) };
    },
    loadEnvironment: async (projectId) => {
      const { data } = await service
        .from("project_environments")
        .select("id, primary_url, environment_type")
        .eq("project_id", projectId)
        .eq("environment_type", "production")
        .maybeSingle();
      if (!data?.primary_url) return null;
      return { id: String(data.id), primaryUrl: String(data.primary_url) };
    },
  };
};

export const secretStoreDeps = (): SecretStoreDeps => {
  const service = serviceClient();
  return {
    encryptionKey: Deno.env.get("AGENT_SECRET_ENCRYPTION_KEY"),
    saveRow: async (row) => {
      const { error } = await service
        .from("project_access_secrets")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "project_id,access_type" });
      if (error) throw new Error("secret_write_failed");
    },
    loadRow: async (projectId, accessType) => {
      const { data } = await service
        .from("project_access_secrets")
        .select("id, project_id, access_type, provider, username, ciphertext, iv, algorithm, key_version, verification_state")
        .eq("project_id", projectId)
        .eq("access_type", accessType)
        .maybeSingle();
      return (data as StoredSecretRow | null) ?? null;
    },
    markVerification: async (projectId, accessType, state, verifiedAt) => {
      // The secret store is the source of truth, and it is written first so
      // the database guard can recognise the matching public timestamp.
      await service
        .from("project_access_secrets")
        .update({ verification_state: state, last_verified_at: verifiedAt })
        .eq("project_id", projectId)
        .eq("access_type", accessType);

      // Then the public metadata the workspace reads. A rejection clears the
      // timestamp rather than leaving a stale claim behind.
      await service
        .from("project_access_methods")
        .update(
          state === "verified"
            ? { status: "available", last_verified_at: verifiedAt }
            : { status: "stale", last_verified_at: null },
        )
        .eq("project_id", projectId)
        .eq("access_type", accessType);
    },
  };
};