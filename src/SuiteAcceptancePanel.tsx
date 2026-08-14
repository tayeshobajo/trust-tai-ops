import { useState } from "react";
import {
  ACCEPTANCE_EVIDENCE_SUMMARY,
  ACCEPTANCE_SUMMARY,
  acceptanceEventKey,
  acceptanceSignal,
  describeSyncResult,
  resolveAcceptanceTarget,
} from "./suite/acceptance";
import type { AcceptanceOutcome } from "./suite/acceptance";
import { sendSuiteSignal } from "./suite/client";
import { getSuiteSession } from "./suite/osToken";
import type { Organization } from "./types";

/**
 * TEMPORARY. A one-shot control that emits a single, clearly-labelled
 * acceptance signal through the production suite sync path so the
 * Ops -> Trust Tai OS return path can be verified on live infrastructure.
 * Delete this component once the live row has been confirmed.
 */
export function SuiteAcceptancePanel({ workspace }: { workspace: Organization }) {
  const target = resolveAcceptanceTarget(getSuiteSession(), workspace.projects);
  const [outcome, setOutcome] = useState<AcceptanceOutcome | null>(null);
  const [sending, setSending] = useState(false);

  if (!target) return null;

  const run = async () => {
    setSending(true);
    try {
      setOutcome(describeSyncResult(await sendSuiteSignal(acceptanceSignal(target))));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="set-block">
      <h2>Suite acceptance test</h2>
      <p className="set-note">
        Temporary. Sends one clearly-labelled acceptance signal to Trust Tai OS to prove the return path. It executes no
        technical work, touches no site, and is not a project QA result. Press it twice: the second press should report
        a duplicate.
      </p>
      <dl className="set-rows">
        <div className="set-row">
          <dt>Event key</dt>
          <dd>{acceptanceEventKey(target.canonicalProjectId)}</dd>
        </div>
        <div className="set-row">
          <dt>Summary sent</dt>
          <dd>{ACCEPTANCE_SUMMARY}</dd>
        </div>
        <div className="set-row">
          <dt>Evidence note</dt>
          <dd>{ACCEPTANCE_EVIDENCE_SUMMARY}</dd>
        </div>
      </dl>
      <button type="button" className="secondary-button" onClick={run} disabled={sending}>
        {sending ? "Sending…" : "Run Suite Acceptance Test"}
      </button>
      {outcome ? (
        <p className="set-note">
          <span
            className={`status-chip tone-${outcome.tone === "good" ? "steady" : outcome.tone === "bad" ? "alert" : "quiet"}`}
          >
            {outcome.label}
          </span>{" "}
          {outcome.detail}
        </p>
      ) : null}
    </section>
  );
}