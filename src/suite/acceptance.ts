/**
 * Temporary suite acceptance harness.
 *
 * This exists to prove one thing: that an Ops event travels through the real
 * production sync path into Trust Tai OS `public.activities`, is idempotent at
 * the database level, and can be routed back to Ops. It performs no technical
 * work, touches no site, and must never be read as project truth.
 *
 * Remove this module and its panel once the live row has been verified.
 */

import type { OpsSuiteSignal, SuiteSyncResult } from "./osActivity";
import type { SuiteSession } from "./osToken";
import type { Project } from "../types";

export const ACCEPTANCE_KEY_PREFIX = "suite-acceptance-v1";

export const ACCEPTANCE_SUMMARY =
  "TEMPORARY SUITE ACCEPTANCE TEST — Ops return-path verification. Not a real QA result.";

export const ACCEPTANCE_EVIDENCE_SUMMARY =
  "Acceptance-only harness event. No technical work was executed and no project QA was performed.";

/** Deterministic per canonical project, so a second press proves idempotency. */
export function acceptanceEventKey(canonicalProjectId: string): string {
  return `${ACCEPTANCE_KEY_PREFIX}:${canonicalProjectId}`;
}

export type AcceptanceTarget = { opsProjectId: string; canonicalProjectId: string };

/**
 * The control is only offered when there is a live OS session *and* an Ops
 * project actually linked to that session's canonical project. Anything less
 * would emit an event that cannot be routed back.
 */
export function resolveAcceptanceTarget(
  session: SuiteSession | null,
  projects: Pick<Project, "id" | "trustTaiOsProjectId">[],
): AcceptanceTarget | null {
  if (!session || !session.osAccessToken) return null;
  const canonicalProjectId = session.canonicalProjectId;
  if (!canonicalProjectId) return null;
  const linked = projects.find((project) => project.trustTaiOsProjectId === canonicalProjectId);
  if (!linked) return null;
  return { opsProjectId: linked.id, canonicalProjectId };
}

/**
 * The harness signal. `ops.qa_passed` is used only because it is a benign,
 * already-allowed event type; the summary and provenance say plainly that this
 * is an acceptance fixture.
 */
export function acceptanceSignal(target: AcceptanceTarget): OpsSuiteSignal {
  return {
    event: "ops.qa_passed",
    opsProjectId: target.opsProjectId,
    canonicalProjectId: target.canonicalProjectId,
    opsRunId: null,
    opsEventKey: acceptanceEventKey(target.canonicalProjectId),
    summary: ACCEPTANCE_SUMMARY,
    evidenceRef: null,
    evidenceSummary: ACCEPTANCE_EVIDENCE_SUMMARY,
  };
}

export type AcceptanceOutcome = { tone: "good" | "quiet" | "bad"; label: string; detail: string };

/** Honest rendering of what the sync path actually returned. */
export function describeSyncResult(result: SuiteSyncResult): AcceptanceOutcome {
  switch (result.status) {
    case "written":
      return { tone: "good", label: "Written", detail: "One new activity row reached Trust Tai OS." };
    case "duplicate":
      return {
        tone: "good",
        label: "Duplicate",
        detail: "Trust Tai OS already holds this event key. Idempotency held: no second row.",
      };
    case "unavailable":
      return { tone: "quiet", label: "Unavailable", detail: `Nothing was sent — ${result.reason.replace(/_/g, " ")}.` };
    case "rejected":
      return { tone: "bad", label: "Rejected", detail: `Blocked before sending — ${result.reason.replace(/_/g, " ")}.` };
    case "failed":
    default:
      return { tone: "bad", label: "Failed", detail: `Trust Tai OS did not accept the write — ${result.reason}.` };
  }
}
