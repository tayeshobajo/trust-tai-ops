# Fix Core -> Ops SSO

## What is actually happening

The handoff from `cmd.trusttai.com` is working. The postMessage arrives, the token is
accepted, and Ops calls the exchange function. The exchange function then answers
**403** — twice, at 23:11 and 23:12 UTC today (confirmed in the live edge logs).

A 403 from that function means one thing: **the signed-in Trust Tai OS account has no
Ops membership row**. Ops currently knows exactly two people:

- `qa@trusttai.com`
- `tai@trusttai.com`

Anyone signing in at Core under any other address — or under a different address than
the one stored in Ops — is refused, correctly and by design.

The second problem is that the screen never says this. It shows the generic
"The secure handoff could not be completed." because the browser call collapses every
non-200 answer into one anonymous failure, so the specific "no Ops access yet" wording
that already exists is never reachable.

## The fix

**1. Say the real reason on screen**
Read the error body the exchange function already returns instead of discarding it, so
a refusal renders as "This account does not have Ops access yet" together with the exact
email that was refused, plus the existing wording for expired sessions and disabled
accounts. A blocked person will then know who to add rather than seeing a dead end.

**2. Record the refused identity server-side**
Log the verified OS email and user id on every refusal (never the token). Right now the
function logs nothing, so a 403 gives no way to tell who was turned away.

**3. Grant Ops access to the Core account**
Add the Core account being used to sign in to the Ops membership list, scoped to the
existing organization, and link it to its Trust Tai OS user id so future sign-ins match
on identity rather than on email text. Email matching also becomes whitespace- and
case-insensitive so a stored address with stray casing or spacing no longer refuses a
legitimate person.

**4. Re-verify end to end**
Sign in at `cmd.trusttai.com`, open Ops, and confirm the landing screen goes straight
into the workspace with no second sign-in, that a deep link lands on that exact project,
and that an account outside the organization is still refused with the explicit message.

## Technical notes

- `supabase.functions.invoke` returns `FunctionsHttpError` for 4xx/5xx with `data` null;
  `src/suite/client.ts` must read `error.context.json()` to recover `no_ops_membership`,
  `ops_access_disabled`, `os_token_rejected`, `session_bootstrap_failed`.
- `src/SsoLanding.tsx` already has copy keyed by those codes; it also needs a case for
  `session_bootstrap_failed` and the refused email in the membership message.
- `supabase/functions/os-sso-exchange/index.ts`: add `console.log` on the refusal paths
  (email + os user id only), and normalise email lookup with trim + lower.
- Membership grant is an insert into `public.users` (organization
  `a454287b-1f3e-42ee-bf1a-9ac4f49d8bd8`), applied through a migration.

## One thing I need from you

Which email address are you signed in as at `cmd.trusttai.com`? If it is not
`tai@trusttai.com`, that address is the missing membership row and I will add it.
