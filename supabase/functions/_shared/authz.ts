/**
 * Server-side caller and project authorization.
 *
 * Nothing the browser says about identity, ownership, capabilities or the site
 * address is trusted. The caller is resolved from the bearer token, and project
 * membership is proven against the database with a service-role read.
 *
 * Dependencies are injected so this logic is exercised by the security checks
 * without a live Supabase project.
 */

export type AuthzFailure = "unauthorized" | "forbidden" | "execution_context_unavailable";

export type Caller = { userId: string; email: string };

export type ProjectContext = {
  projectId: string;
  organizationId: string;
  primaryDomain: string;
  canonicalUrl: string | null;
  environmentId: string | null;
};

export type AuthzDeps = {
  /** Verifies the bearer token. Returns null for any invalid/expired token. */
  verifyToken: (token: string) => Promise<Caller | null>;
  /** Service-role read of the project row. Null when it does not exist. */
  loadProject: (projectId: string) => Promise<
    { id: string; organizationId: string; primaryDomain: string } | null
  >;
  /** Service-role read of the caller's organization membership. */
  loadMembership: (email: string) => Promise<{ organizationId: string } | null>;
  /**
   * Preferred membership lookup: the app user row bound to this auth UID by
   * key. Email matching stays only as a transitional fallback for rows created
   * before `users.auth_user_id` existed.
   */
  loadMembershipByAuthId?: (authUserId: string) => Promise<{ organizationId: string } | null>;
  /** Service-role read of the project's canonical environment. */
  loadEnvironment: (projectId: string) => Promise<{ id: string; primaryUrl: string } | null>;
};

export const bearerToken = (authorizationHeader: string | null): string | null => {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
};

export type AuthzResult =
  | { ok: true; caller: Caller; project: ProjectContext }
  | { ok: false; code: AuthzFailure };

/**
 * Proves: (1) a real signed-in caller, (2) that caller belongs to the
 * organization owning the project. Fails closed on every uncertainty.
 */
export const authorizeProject = async (
  authorizationHeader: string | null,
  projectId: string,
  deps: AuthzDeps,
): Promise<AuthzResult> => {
  const token = bearerToken(authorizationHeader);
  if (!token) return { ok: false, code: "unauthorized" };
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    return { ok: false, code: "execution_context_unavailable" };
  }

  let caller: Caller | null;
  try {
    caller = await deps.verifyToken(token);
  } catch {
    return { ok: false, code: "unauthorized" };
  }
  if (!caller || !caller.email) return { ok: false, code: "unauthorized" };

  let project: Awaited<ReturnType<AuthzDeps["loadProject"]>>;
  let membership: Awaited<ReturnType<AuthzDeps["loadMembership"]>>;
  try {
    project = await deps.loadProject(projectId);
    // UID first. Identity by key beats identity by string comparison.
    membership = deps.loadMembershipByAuthId ? await deps.loadMembershipByAuthId(caller.userId) : null;
    if (!membership) membership = await deps.loadMembership(caller.email);
  } catch {
    return { ok: false, code: "execution_context_unavailable" };
  }

  if (!project || !membership) return { ok: false, code: "forbidden" };
  if (project.organizationId !== membership.organizationId) return { ok: false, code: "forbidden" };

  let environment: Awaited<ReturnType<AuthzDeps["loadEnvironment"]>> = null;
  try {
    environment = await deps.loadEnvironment(projectId);
  } catch {
    environment = null;
  }

  const canonical =
    environment?.primaryUrl?.trim() ||
    (project.primaryDomain?.trim() ? `https://${project.primaryDomain.trim()}` : "");

  return {
    ok: true,
    caller,
    project: {
      projectId: project.id,
      organizationId: project.organizationId,
      primaryDomain: project.primaryDomain,
      canonicalUrl: canonical || null,
      environmentId: environment?.id ?? null,
    },
  };
};