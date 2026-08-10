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

Copy `.env.example` to `.env.local` or your preferred local env file.

**Frontend / public only** (compiled into the browser bundle):

- `VITE_OPS_REPOSITORY_ADAPTER`
- `VITE_OPS_SUBDOMAIN`
- `VITE_OPS_SUPABASE_URL` — public Supabase URL
- `VITE_OPS_SUPABASE_PUBLISHABLE_KEY` — public anon/publishable key
  (`VITE_OPS_SUPABASE_ANON_KEY` accepted as a legacy alias)
- `VITE_OPS_SUPABASE_SCHEMA`

**Edge Function / server only** (Supabase Edge Function secrets, never here):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` — only if used for caller token claims
- `SUPABASE_SERVICE_ROLE_KEY`
- `AGENT_SECRET_ENCRYPTION_KEY`

The service-role key and the encryption key must **never** use a `VITE_` prefix
and must **never** enter browser env.

## BYO Supabase deployment order

The full eight-step production sequence lives in `BRIEF.md` → *Deployment truth
(private read layer)*:

1. Apply migrations
2. Configure Edge Function secrets
3. Deploy `access-secrets`
4. Deploy `agent-execute`
5. Sign in with a real Supabase user mapped to the app `users` organization
6. Store a WordPress Application Password
7. Verify it read-only
8. Run a private plugin/health read

### Optional: SSH + read-only WP-CLI

Additive to the eight steps, and read-only by construction. Full detail in
`BRIEF.md` → *SSH + read-only WP-CLI*.

9. Add a dedicated agent SSH key to the server's `authorized_keys`
10. Store host, port, username, private key and WordPress path via Access &
    Connections → SSH (the key is sealed with `AGENT_SECRET_ENCRYPTION_KEY`)
11. Press *Verify access* — the only moment an unknown host key is accepted; the
    server pins the SHA256 fingerprint it observes
12. Compare that fingerprint against `ssh-keygen -lf` on the server

After the pin exists, any run against a changed host key is refused before
authentication. Only the fixed catalog in
`supabase/functions/_shared/wpCliCatalog.ts` can be executed; there is no
free-text command path. Verify the safety model with `npm run check:wpcli`.

## Tenant identity

`auth_user_id` is preferred and resolves from `auth.uid()`. Email matching is a
transitional fallback for unmigrated rows only. Backfill `users.auth_user_id`
during production rollout and remove reliance on email matching afterwards.

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
