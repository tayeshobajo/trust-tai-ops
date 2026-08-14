/**
 * Canonical project linking.
 *
 * Trust Tai OS owns the canonical business project. Ops owns the technical
 * workspace. The link is one explicit uuid, resolved deterministically:
 * exact canonical id match, or nothing. Names are never compared, because a
 * fuzzy match here silently attaches a real client's operational state to the
 * wrong business project.
 */

export type LinkableProject = {
  id: string;
  name: string;
  trustTaiOsProjectId?: string | null;
};

export type CanonicalLinkDecision =
  | { kind: "no_canonical_context" }
  | { kind: "already_linked"; opsProjectId: string }
  | { kind: "conflict"; opsProjectIds: string[] }
  | { kind: "needs_choice" };

export function decideCanonicalLink(
  canonicalProjectId: string | null,
  projects: LinkableProject[],
): CanonicalLinkDecision {
  if (!canonicalProjectId) return { kind: "no_canonical_context" };

  const wanted = canonicalProjectId.toLowerCase();
  const matches = projects.filter(
    (project) => (project.trustTaiOsProjectId ?? "").toLowerCase() === wanted,
  );

  if (matches.length === 1) return { kind: "already_linked", opsProjectId: matches[0].id };
  if (matches.length > 1) return { kind: "conflict", opsProjectIds: matches.map((p) => p.id) };

  // No link yet. The human picks an existing Ops project or creates a new
  // technical workspace. Nothing is attached automatically.
  return { kind: "needs_choice" };
}

/**
 * Guards the write side: an Ops project may hold at most one canonical id,
 * and a canonical id may be held by at most one Ops project.
 */
export function canLinkProject(
  canonicalProjectId: string,
  opsProjectId: string,
  projects: LinkableProject[],
): { allowed: boolean; reason?: "already_linked_elsewhere" | "ops_project_linked_to_other" } {
  const wanted = canonicalProjectId.toLowerCase();

  const holder = projects.find(
    (project) => (project.trustTaiOsProjectId ?? "").toLowerCase() === wanted,
  );
  if (holder && holder.id !== opsProjectId) {
    return { allowed: false, reason: "already_linked_elsewhere" };
  }

  const target = projects.find((project) => project.id === opsProjectId);
  const current = (target?.trustTaiOsProjectId ?? "").toLowerCase();
  if (current && current !== wanted) {
    return { allowed: false, reason: "ops_project_linked_to_other" };
  }

  return { allowed: true };
}