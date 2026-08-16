# Get the build clean and redeploy agent-reason

## What is actually broken

One TypeScript error blocks the build:

`src/conversation.ts(222)` has a `case "approval_required":` branch, but `RunState`
(defined in `src/types.ts`) does not contain that value. The run states are:
intake, access_check, backup_gate, environment_mapping, diagnosis, plan, execution,
qa, recommendations, complete, paused, escalated, failed, rolled_back.

Important constraint found while checking: the database also rejects that value.
`db/schema.sql` puts a `check (state in (...))` on both run tables with the same 14
states, so simply widening the TypeScript union would compile but any run persisted
in an `approval_required` state would be rejected by Postgres at write time.

Note: `"approval_required"` does exist, but as an orchestrator *stop reason*
(`src/agent-core/types.ts`), not as a run state. That is the source of the mix-up.

## Recommended fix (no schema change)

Approval already has a real home: the `plan` state with `approvalRequired = true`,
which `src/conversation.ts` already renders as an approval decision.

1. In `src/conversation.ts`, remove the unreachable `case "approval_required"` block
   and move its one useful behaviour — pulling the first step `preview` out of the
   `fix_plan` artifact to show a before/after diff — into the existing `plan` case,
   as a fallback used when no pending `high_risk_execution` approval carries its own
   preview.
2. Keep the fix-plan message copy ("I've put together a fix plan for this…") so the
   approval prompt still reads the same when a fix plan exists.

This keeps run state, the DB constraint, and the executor (which already advances to
`plan`) consistent, and needs no migration.

### Alternative, if approval_required must be a real state
Add it to `RUN_STATES`, add a migration that rewrites the `check` constraint on both
run tables, and update phase/label maps and the executor to enter and leave the state.
Larger change; only worth it if the run timeline should visibly stop at "awaiting
approval" as its own phase.

## Then

3. Run the full TypeScript build (`tsconfig.app.json`) and confirm zero errors.
4. Redeploy the `agent-reason` edge function.
5. Re-verify `plan_fix` end to end against the deployed function with an authenticated
   call, confirming a valid plan comes back (steps + verification goal) and that the
   new optional `preview` field on fix steps survives parsing.
