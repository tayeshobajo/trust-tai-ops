# Trust Tai Ops

## Product Thesis

`ops.trust-tai.com` is a multi-project technical agent for WordPress.

It is not a control panel and not a run console.
The application layer stays radically simple:

**Projects are the container. Chat is the application. The agent carries the complexity.**

A user creates or opens a project and works primarily through conversation with an expert
engineering agent. They describe the issue in plain English, provide access when asked,
confirm safety steps only when necessary, watch the work happen, and receive a verified
completion report. Project memory persists across conversations.

## V1 Promise

Open a project.
Explain the problem in plain English.
Give the agent access when it asks.
Approve the one or two decisions that genuinely need a human.
Watch the agent work.
Leave with a verified result, recommendations, and memory that compounds.

## Core UX Law

Never make the human operate the agent's internal workflow.

A non-technical person should be able to create a project and resolve an issue by sharing
the issue brief and whatever access they have: WordPress Admin, SFTP/FTP, SSH, hosting,
database, CDN/Cloudflare, or staging.

## What Stays Underneath

State machines, risk classification, backup gates, approvals, QA contracts, evidence,
rollback logic, audit trails, run orchestration, recommendations, and technical memory are
real system capabilities. They stay in the domain model. They are not primary navigation and
the user does not operate them by hand.

They surface only when the user needs to know something or make a decision:

- no backup checkbox — the agent asks for backup confirmation in conversation when needed
- no Advance Run control — the agent moves through lawful internal states itself
- no approval panel — the agent explains the proposed action and asks for a yes or a question
- no standalone QA workflow — the agent runs final checks and reports the evidence

## Primary Surfaces

1. **Projects Command Center** — WhatsApp/Telegram-inspired project inbox: name, domain,
   latest activity, attention indicator, and a preview pane before opening.
2. **Create Project** — project name, website URL, optional context, access connections.
   No WordPress version, PHP version, host details, task type, risk level, urgency, or
   backup state up front. Those are asked for later, only if contextually needed.
3. **Project Workspace** — chat-first: project conversations/tasks on the left, the
   Engineering Agent conversation in the center, quiet current-task context on the right.

Secondary project surfaces: Tasks, Memory, Access, Activity — they support the conversation
and must not dominate it.

Global secondary surfaces: Activity, Team, Settings.

## Agent Voice

The agent communicates like a calm senior WordPress engineer. It explains what it is
checking, what it found, what it needs from the human, what it recommends, what it is doing
now, what was verified, and what remains recommended.

The user should never need to understand internal run-state vocabulary.

## V1 Boundary

WordPress operations only:

- malware cleanup
- performance optimization
- plugin/theme conflict diagnosis
- broken update recovery
- hardening
- QA and post-run recommendations

Not in V1: general devops, non-WordPress stacks, open-ended agent autonomy,
billing/client portal work.

## Locked Constraints

- Stack: Vite + React + TypeScript + Supabase, vanilla CSS.
  No Tailwind, no shadcn, no router framework migration.
- Design system: the Trust Tai tokens in `src/index.css` are the source of truth.
  Warm paper, deep ink/navy, restrained Trust Tai blue signal, editorial typography,
  generous spacing, fine borders, subtle depth. A private technical studio, not a
  generic SaaS dashboard.
- Domain model and safety logic are preserved. Prefer recomposing the application layer
  over rewriting the backend model.

## Build Discipline

Before adding any page, field, status, dashboard, or control, ask:
does the user need this to create a project, give the agent what it needs, make a decision,
or trust the completed work?

If not, it belongs underneath the application layer.

## Deployment truth (private read layer)

Nothing in the private WordPress path works from the browser alone. It requires
a deployed backend. Bring your own Supabase project and run these eight steps in
this exact order:

1. **Apply migrations.** Run every file in `db/migrations/` in filename order.
   They are idempotent and safe to re-run.
   `20260816_audit_identity_alignment.sql` converts legacy text identity columns
   to `uuid` without dropping history; `20260818_verification_integrity.sql`
   adds `users.auth_user_id` and the trigger that stops the browser from forging
   a verification timestamp.
2. **Configure Edge Function secrets.** At minimum
   `AGENT_SECRET_ENCRYPTION_KEY` (32 bytes, base64 or 64 hex chars):
   `supabase secrets set AGENT_SECRET_ENCRYPTION_KEY=...`. Until it exists,
   credential storage is refused rather than silently downgraded. `SUPABASE_URL`
   and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
3. **Deploy `access-secrets`.** This is the only route that may seal a
   credential or record a verification.
4. **Deploy `agent-execute`.** This is the only route that may use a sealed
   credential to read from WordPress.
5. **Sign in with a real Supabase user mapped to the app `users` organization.**
   A session that resolves to no organization row is refused, not defaulted.
6. **Store a WordPress Application Password** through Access & Connections. The
   value goes straight to `access-secrets` and is never held in the browser.
7. **Verify it read-only.** Press *Verify access*. The server calls
   `/wp-json/wp/v2/users/me?context=edit` against the project's own canonical
   origin and records the outcome itself.
8. **Run a private plugin/health read** — `wordpress.list_plugins` or
   `wordpress.read_health` — to confirm the verified credential actually
   produces private evidence.

Until all eight are done, the app runs in its local demo adapter, where no
credential is real and no WordPress site is contacted.

### Environment boundary

**Frontend / public only** (compiled into the browser bundle, readable by
anyone):

- `VITE_OPS_SUPABASE_URL` — the project's public Supabase URL
- `VITE_OPS_SUPABASE_PUBLISHABLE_KEY` — the public anon/publishable key
  (`VITE_OPS_SUPABASE_ANON_KEY` is accepted as a legacy alias)

**Edge Function / server only** (never in a `.env` the browser build reads):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` — only if used for verifying caller token claims
- `SUPABASE_SERVICE_ROLE_KEY`
- `AGENT_SECRET_ENCRYPTION_KEY`

The service-role key and the encryption key must **never** carry a `VITE_`
prefix and must **never** enter browser env. Anything prefixed `VITE_` is
compiled into the bundle; a service-role key there is a full database
compromise, and an encryption key there makes every sealed credential readable.

### Tenant identity: UID first

- `auth_user_id` is the preferred claim. Identity resolves from `auth.uid()`.
- Email matching is a **transitional fallback for unmigrated rows only**, and it
  is a weaker claim.
- **Backfill `users.auth_user_id`** for every existing member during production
  rollout.
- **Remove reliance on email matching after the backfill** completes.

### Stored is not verified

Two distinct facts, never collapsed:

- **Stored** — the credential is sealed in the server-only secret store and
  can be decrypted by the Edge Function. It proves nothing about whether it
  works.
- **Verified** — WordPress itself accepted the credential on a read-only
  authenticated call. Only the server may record this, and only after a real
  200 response.

`last_verified_at` stays null until then. The agent says "stored securely"
before verification and "verified" only after, and it distinguishes stored from
verified capabilities when deciding what it may attempt.
