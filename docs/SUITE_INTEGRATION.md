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

## Deployment steps (not yet performed)

1. **Migration** — apply `db/migrations/20260834_os_suite_link.sql` to the Ops
   Supabase project. It is idempotent (`add column if not exists`, partial
   unique index guarded by `if not exists`).
2. **Edge Function** — deploy the function slug `os-sso-exchange`. It is
   registered in `supabase/config.toml` with `verify_jwt = false`, because the
   caller has no Ops session yet; the OS token in the body is verified against
   the OS auth service inside the function.
3. **Ops function secrets** — set on the Ops project:
   - `TRUST_TAI_OS_SUPABASE_URL` = `https://okydosoacqdnursmmenf.supabase.co`
   - `TRUST_TAI_OS_PUBLISHABLE_KEY` = the OS browser-safe anon/publishable key
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` already exist and are used
   only inside the function.
4. **Browser-safe build vars** — set in the hosting environment (and mirrored
   in `.env.production`):
   - `VITE_OPS_OS_SUPABASE_URL`
   - `VITE_OPS_OS_SUPABASE_PUBLISHABLE_KEY`
   - `VITE_OPS_OS_ORIGINS` — exact origins, comma separated, no wildcards.
     Add the production OS origin when it exists.
5. **Trust Tai OS side** — open Ops at `https://ops.trusttai.com/sso` and
   `postMessage` `{ type: "trust-tai-os:sso", accessToken, canonicalProjectId? }`
   to the opened window, targeting the Ops origin exactly. Do not append the
   token to the URL.

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