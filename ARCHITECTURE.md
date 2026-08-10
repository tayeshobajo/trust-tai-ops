# Ops Trust Tai Architecture

## Product Spine

The scaffold needs four contracts from day one:

1. Project contract
2. Run contract
3. Guardrail contract
4. QA contract

Without these, the UI becomes theater and the agent becomes improvisation.

## Project Contract

Each project contains:

- identity: name, client, domain
- environments
- access methods
- memory entries
- QA rules
- risk flags
- recommendations
- run history

This keeps context isolated per client and makes memory reusable.

## Run Contract

Every task becomes a run with:

- title
- task type
- urgency
- target environment
- state
- risk level
- backup status
- diagnosis summary
- plan summary
- findings
- actions
- artifacts
- approvals
- QA report
- recommendations

## State Contract

Normal state order:

1. Intake
2. Access Check
3. Backup Gate
4. Environment Mapping
5. Diagnosis
6. Plan
7. Execution
8. QA
9. Recommendations
10. Complete

Special states:

- Paused
- Escalated
- Failed
- Rolled Back

The UI should never offer actions the current state does not allow.

## Guardrail Contract

Policy evaluation depends on:

- current state
- task type
- environment type
- risk level
- access readiness
- backup status
- approval status
- project fragility notes

Core enforcement:

- read-only first
- reversible before irreversible
- diagnosis before execution
- backup before risk
- QA before closure

## QA Contract

QA is first-class, not a field on the run.

Each project defines QA rules.
Each run produces:

- verdict
- per-check results
- residual risk
- summary

Completion requires QA or an approved waiver.

## Frontend Contract

The front end is part of the safety system.

It should:

- stay project-first, not prompt-box-first
- keep the next action obvious
- show shared run state clearly
- reveal technical depth progressively
- make risk visible without clutter

## Phase 1 Build Decision

Use a lean Vite + React + TypeScript app with local persistence and seeded data so the product shape can be tested before backend work starts.
