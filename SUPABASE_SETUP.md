# Supabase Setup

This app is still Vite client-first.
That means:

- browser-safe public key only in `.env`
- no service-role key in any `VITE_` variable
- write access must eventually rely on auth + RLS or a separate server/API layer

## Current adapter modes

- `demo` — local browser persistence
- `supabase` — direct browser reads/writes through the configured public key
- `auto` — prefers Supabase when valid public config exists, otherwise falls back to demo

## Env contract

Copy `.env.example` to `.env.local` or your preferred local env file and set:

- `VITE_OPS_REPOSITORY_ADAPTER`
- `VITE_OPS_SUBDOMAIN`
- `VITE_OPS_SUPABASE_URL`
- `VITE_OPS_SUPABASE_PUBLISHABLE_KEY`
- `VITE_OPS_SUPABASE_SCHEMA`

## SQL

Apply `db/schema.sql` to the target Supabase project.

## Security boundary

This pass does not add full auth/RLS yet.
It wires the browser-safe adapter only.

The next hardening pass should add:

1. audit event writes
2. server-side flows for anything that should not be public-key writable
3. approval-specific server actions
4. stronger credential-handling boundaries

## Current state

This repository now includes:

- auth-aware UI scaffolding
- role-sensitive client gating
- `db/rls.sql` policy foundation

What it does **not** claim yet:

- production-complete auth
- production-complete RLS validation
- server-side protection for privileged writes
