# Agent System Thinking — Specification

Eight capabilities that turn Trust Tai's executor from a tool-runner into an
engineer. Each section states the contract, the data, the seam it hooks into,
and the observable behaviour that proves it works.

The ordering is delivery order. Later passes assume earlier ones exist.

---

## Pass 1 — Persistent working plan

**Contract.** Every run carries one living plan: a goal, a set of hypotheses
with a truth status, and an ordered list of steps. The agent revises it as
facts arrive. The user can read it at any moment and correct it.

**Model** (`src/agent-core/plan.ts`)

```
RunPlan {
  runId, projectId, revision
  goal: string
  hypotheses: { id, text, status: open | supported | ruled_out, note }[]
  steps: { id, label, toolId?, status: pending | active | done | blocked | skipped, note, evidenceId? }[]
  updatedAt
}
```

**Storage.** `public.run_plans`, one row per run (`run_id` unique), jsonb
columns for `hypotheses` and `steps`, `revision` monotonic. RLS via
`private.can_reach_project`.

**Seam.** `runAgentTurn` in `src/agent-core/orchestrator.ts`. The plan is
loaded before the loop, reconciled against the reasoner's actions at the top of
each iteration, marked `active` before `executeAction`, resolved to
`done`/`blocked` after, and saved once at the end of the turn.

**Surface.** The workspace right rail (`aside.pw-context`) renders goal,
hypotheses, and steps above the phase track. Plain English only — no tool ids.

**Proof.** Reload mid-run: the plan is identical. Ruling a hypothesis out is
visible without reading the transcript.

---

## Pass 2 — Read-before-write preconditions

**Contract.** No mutating tool may touch a target the agent has not read in the
current run. The read produces a content hash; the write carries that hash as a
precondition; the executor refuses if the live hash differs.

**Model.** `ToolDescriptor` gains:

```
mutates: false | { targetKind: "file" | "database" | "wordpress_option", requiresPriorReadOf: ToolId[] }
```

`AgentAction` gains `precondition?: { targetKey: string, contentHash: string }`.

**Seam.** `evaluateAction` in `src/agent-core/policy.ts` gains a fourth gate
after capability/backup/approval: `requires: "prior_read"` when a mutating
action has no matching succeeded read event for the same `targetKey` in
`agent_execution_events` for this run. The gateway re-verifies the hash
server-side immediately before the write — the client hash is a hint, the
server hash is the gate.

**Storage.** Reuse `agent_execution_events.evidence_data`; read tools persist
`{ targetKey, contentHash }`. No new table.

**Proof.** A `filesystem.write` planned without a preceding `filesystem.read`
of the same path is blocked with a plain-English reason. A write whose file
changed underneath is refused, not overwritten.

---

## Pass 3 — Per-step verification

**Contract.** A step is not `done` until its own evidence is captured. QA stops
being a terminal phase and becomes a property of every action.

**Model.** Each `ReasonStepSpec` declares a `verify` descriptor: which tool
re-observes, and a predicate over the resulting evidence.

```
verification: { toolId: ToolId, expectation: string, check: (before, after) => "passed" | "failed" | "inconclusive" }
```

**Seam.** `executeAction` returns `{ kind: "evidence" }`; the orchestrator then
runs the verification action, records a second execution event tagged
`verification`, and writes the outcome into the plan step and into
`qa_results` against the run's `qa_report`. Read-only steps verify trivially
(evidence non-empty); change steps re-read the mutated target.

**Proof.** Every completed step in the plan shows what was checked. A change
whose verification fails marks the step `blocked` and speaks up immediately
rather than at the end of the run.

---

## Pass 4 — Parallel read-only investigators

**Contract.** The turn loop stops running exactly one observation per
iteration. Independent read-only actions in the same plan fan out together, and
only their conclusions re-enter the reasoner's context.

**Model.** `investigate(actions: AgentAction[])` runs a bounded batch
(`MAX_PARALLEL_OBSERVATIONS = 4`) through `Promise.allSettled`, subject to:
all actions read-only, distinct `invocationKey`, distinct tool where the tool
holds a single connection (SSH, SFTP).

**Seam.** `src/agent-core/budgets.ts` gains the ceiling;
`runAgentTurn` replaces the single `plan.actions.find(...)` with a batch
selector. Sequencing is preserved for anything not read-only.

**Context discipline.** Raw evidence is summarised per batch before being
folded back into `AgentContext.evidence`, so a wide fan-out does not blow the
reasoner's window.

**Proof.** A four-signal diagnosis (public surface, health, plugins, error log)
completes in roughly one tool-latency instead of four.

---

## Pass 5 — Failure taxonomy and escalation ladder

**Contract.** Failures are classified, and the class determines the response.
The same error is never retried blindly three times.

**Model** (`src/agent-core/failure.ts`)

```
FailureClass = transient | permission | environment | logic | policy

escalate(code, attempts) ->
  | { action: "retry", delayMs }         transient, attempts < 2
  | { action: "alternate_route" }        environment/logic, a sibling tool exists
  | { action: "ask_human", need }        permission (access or approval)
  | { action: "stop", reason }           policy, or ladder exhausted
```

Mapping: `timeout`/`network_error` → transient. `unauthorized`/`forbidden`/
`capability_unavailable`/`secret_store_unavailable` → permission.
`execution_backend_unavailable`/`tool_unavailable`/`not_implemented` →
environment. `invalid_input`/`unsafe_destination` → logic.
`blocked_by_policy` → policy.

**Seam.** The `outcome.kind === "failed"` branch of `runAgentTurn` delegates to
`escalate` instead of the current inline `retryable && attempts < MAX` check.
`alternate_route` records the dead end in `failedObservations` and continues;
`ask_human` sets `awaiting` and breaks with the right plain-English ask.

**Proof.** Three consecutive failures of the same class end in a different
approach or a clear question, never a loop.

---

## Pass 6 — Diff-first approvals

**Contract.** The user approves a diff, not a sentence. Every mutating action
produces a preview before it is proposed.

**Model.** New tool method `preview(action) -> ChangePreview`:

```
ChangePreview =
  | { kind: "file", path, before: string, after: string, truncated: boolean }
  | { kind: "sql", statements: string[], affectedEstimate: number }
  | { kind: "package", changes: { name, from, to }[] }
  | { kind: "command", commandId, argsSummary }
```

**Storage.** `run_approvals` gains `preview jsonb` and `preview_hash text`. The
hash is bound into the execution precondition (Pass 2), so approving a diff
approves *that* diff.

**Seam.** The orchestrator's autonomy line — `if (!action.readOnly)` — calls
`preview` before setting `awaiting = "approval"`, and persists the preview onto
the approval record. `ProjectWorkspace`'s approval card renders it with a
unified-diff view for file kinds.

**Proof.** No approval card exists without a rendered preview. Approving a
stale preview is rejected server-side.

---

## Pass 7 — Auto-written constraint memory

**Contract.** When the user corrects the agent or states a boundary, that
becomes a constraint memory immediately, and constraints are injected into
every subsequent reasoning call.

**Model.** `project_memory_entries.memory_type` gains `constraint`.
Constraints carry `source_message_id` (already present) and are never
auto-superseded — only the user retires them.

**Detection.** Two paths, both server-side:
1. Deterministic: negative-imperative patterns against the agent's last
   proposal ("don't", "never", "leave X alone", "not on production").
2. Reasoner-assisted: the intake step classifies a user message as
   `correction | boundary | preference | none` and emits a candidate.

Candidates land in `memory_candidates` with `kind = 'constraint'`. A
correction detected with high confidence is written directly and echoed in
chat as "Noted — I won't do X" so the user can dispute it.

**Seam.** Message persistence in `src/conversation.ts`, then
`supabase/functions/_shared/contextLoader.ts` promotes constraints to the top
of the reasoner prompt block in `reasonPrompt.ts` as hard rules, above
findings and history.

**Proof.** Telling the agent "don't touch the caching plugin" once means the
plugin never appears in a later plan, in a later session.

---

## Pass 8 — Run close-out report

**Contract.** Every run ends with the same three-part statement: what was
verified, what was recommended but not done, and what the user must decide.

**Model.** Derived, not stored: assembled from the plan (Pass 1), the
verification results (Pass 3), `run_recommendations`, and open approvals.

**Seam.** The completion path in `runAgentTurn`/`src/agent.ts` emits a single
`kind: "completion_report"` message, deduped on `closeout-${runId}`.

**Proof.** No run ends silently. The residual is always named.
