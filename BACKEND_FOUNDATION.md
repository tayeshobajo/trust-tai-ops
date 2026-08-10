# Backend Foundation

This phase does not wire live Supabase yet.
It does the two things that matter first:

1. define the canonical relational schema
2. separate the app from direct `localStorage` calls

## What changed

- Canonical SQL schema added at `db/schema.sql`
- Seed data moved into `src/seed.ts`
- Persistence contract added in `src/repository.ts`
- UI now depends on a repository interface instead of touching browser storage directly
- Supabase adapter wiring now exists alongside demo fallback
- Browser-safe env contract now lives in `.env.example`

## Why this matters

The frontend can now keep moving while the next phase swaps in:

- Supabase auth and roles
- Postgres persistence
- approvals and audit trail
- project onboarding flows
- agent-safe per-state backend actions

## Next backend moves

1. add Supabase client + environment configuration
2. map relational rows to the frontend workspace shape
3. add auth + RLS so public-key writes stop being provisional
4. add role-aware policies and audit event writes
