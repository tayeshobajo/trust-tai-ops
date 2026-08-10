# Ops Trust Tai

`ops.trust-tai.com` is the TrustTai command center for WordPress engineering work.

This Phase 1 scaffold proves the product shape before backend wiring:

- multi-project command center
- project memory and access map
- state-driven run view
- guided new-run intake
- QA proof surface
- recommendations and risk ledger

The app is intentionally product-first instead of chatbot-first. The agent is embedded in a governed workflow, not floating above it.

## Current scope

The current scaffold includes:

- TrustTai-branded command-center shell
- seeded WordPress projects and environments
- visible run-state machine
- guardrail-aware intake behavior
- local persistence with browser storage
- repository abstraction for future backend swap-in
- canonical SQL schema at `db/schema.sql`
- browser-safe `demo` / `supabase` adapter switching

## Run locally

1. `npm install`
2. `npm run dev`

## Verification

- `npm run typecheck`
- `npm run build`
- `npm run lint`

## Supabase

See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) and [.env.example](./.env.example) for the browser-safe adapter contract.

Important boundary:
the app now supports a real Supabase adapter, but it still needs auth + RLS or a server/API layer before production-trustworthy live writes.

The current codebase now includes auth-aware UI scaffolding and a first RLS policy contract at `db/rls.sql`.
