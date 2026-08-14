# Trust Tai OS ↔ Ops integration (v1)

Ops stays a separately deployed specialist application at `ops.trusttai.com`
with its own Supabase project (`tdqeizrgdasztvbvwanp`). Trust Tai OS
(`okydosoacqdnursmmenf`) owns canonical business project identity. Ops owns
technical operational state. Nothing was migrated in either direction.

## What was added

| Concern | File |
| --- | --- |
| postMessage handoff validation | `src/suite/ssoBridge.ts` |
| in-memory OS token for the browser session | `src/suite/osToken.ts` |
| exchange + sync runtime | `src/suite/client.ts` |
| suite event vocabulary, redaction, dedupe | `src/suite/osActivity.ts` |
| deterministic canonical link rules | `src/suite/canonicalLink.ts` |
| evidence-backed snapshot | `src/suite/snapshot.ts` |
| `/sso` landing state | `src/SsoLanding.tsx` |
| server-side token exchange | `supabase/functions/os-sso-exchange/index.ts` |
| Ops-side link columns | `db/migrations/20260834_os_suite_link.sql` |
| acceptance checks | `scripts/suite-checks.ts` (`npm run check:suite`) |

## The live OS activities contract

Ops writes to `public.activities` in the OS project using exactly these
columns. `id` and `created_at` are left to the database.

| Column | Ops value |
| --- | --- |
| `organization_id` | OS organization id from the handoff (required) |
| `event_type` | the `ops.*` event (required) |
| `actor_user_id` | verified OS user id, or `null` so OS RLS decides |
| `app_key` | `ops` (required) |
| `entity_type` | `project` when a canonical project is linked, else `null` |
| `entity_id` | canonical project id |
| `summary` | redacted one-line summary |
| `payload` | `ops_project_id`, `canonical_project_id`, `ops_run_id`, `evidence_ref`, `evidence_summary`, `destination_route` (required) |
| `provenance` | `source_app: "ops"`, `source: "trust-tai-ops"`, `ops_event_key`, `dedupe_key`, `ops_project_id` (required) |
| `occurred_at` | the real event time; stamped at emission only when unknown (required) |

There is no `activity_type`, `project_id`, or `metadata` column, and Ops never
sends one. Raw logs, command output, and credential material never cross.

### Idempotency

Dedupe is a read-before-write on `provenance->>dedupe_key` (PostgREST JSON
path filter), scoped to `app_key=eq.ops`. Read-before-write alone is
race-prone. The writer already treats a `409` unique violation as a duplicate,
so when the OS adds a unique index or dedicated idempotency key on
`provenance->>dedupe_key`, the race closes with no Ops change.

## Deployment status

- **Migration `ops_suite_link_v1`** — applied to the live Ops Supabase project.
- **Edge Function `os-sso-exchange`** — present and ACTIVE (v1) in live Ops
  Supabase, registered in `supabase/config.toml` with `verify_jwt = false`
  (the caller has no Ops session yet; the OS token in the body is verified
  inside the function).
- **OS verification secrets** — still required, and **not verified as set**.
  Lovable cannot read or set Edge Function secret values, so this cannot be
  confirmed from here. Set them in Project Settings → Secrets:
  - `TRUST_TAI_OS_SUPABASE_URL` = `https://okydosoacqdnursmmenf.supabase.co`
  - `TRUST_TAI_OS_SUPABASE_ANON_KEY` = `sb_publishable_uARvNwZli88tfhOHBwFTsQ_JUpQo-UL`
  Without them the function returns `os_not_configured` and every handoff
  fails closed.

## Remaining setup

1. **Browser-safe build vars** — already committed to `.env.production` and
   `.env.development` (`VITE_OPS_OS_SUPABASE_URL`,
   `VITE_OPS_OS_SUPABASE_PUBLISHABLE_KEY`, `VITE_OPS_OS_ORIGINS`). These are
   public values. Add the production OS origin to the allowlist when it
   exists — exact origins, comma separated, no wildcards.
2. **Trust Tai OS side** — open Ops at `https://ops.trusttai.com/sso` and
   `postMessage` to the opened window, targeting the Ops origin exactly:
   ```js
   { type: "trust-tai-os:sso", accessToken, organizationId, canonicalProjectId? }
   ```
   `organizationId` is required and must be a UUID; a missing or malformed one
   fails closed. Do not append the token to the URL.

## Manual acceptance that cannot be automated

A live OS user signing in, launching Ops, and landing in a linked project
requires both projects deployed with real sessions. The automated checks cover
everything up to that boundary: origin rejection, malformed handoffs, token
never in URL or `localStorage`, fail-closed direct visits, deterministic
linking, idempotent sync, secret redaction, and snapshot fidelity.

## Security note — rotate the QA credential

A shared QA account password was previously committed to `.env.production`.
That file no longer contains any credential and production QA auto-login is
both disabled by config and hard-refused in `src/env.ts` for production builds.
**The previously committed QA password must be rotated in Supabase**, because
it remains in git history. Rotating it, or deleting the QA auth user outright,
is the only thing that revokes it.