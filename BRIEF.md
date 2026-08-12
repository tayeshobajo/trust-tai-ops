# Trust Tai Ops

## Product Thesis

`ops.trusttai.com` is a multi-project technical agent for WordPress.

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
   a verification timestamp; `20260820_ssh_wp_cli_readonly.sql` adds the
   non-secret `config` column, the pinned `host_fingerprint`, and extends the
   forgery guard to SSH.
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

### SSH + read-only WP-CLI

Optional, and additive to the eight steps above. Nothing here can write.

1. **Create a dedicated SSH key for the agent** and add only its public half to
   the server's `authorized_keys`. Use a separate key so it can be revoked
   without touching anyone else's access.
2. **Store it** through Access & Connections → SSH: host, port, username, the
   whole private key, an optional passphrase, and the WordPress folder. The key
   goes straight to `access-secrets` and is sealed with the same
   `AGENT_SECRET_ENCRYPTION_KEY`. Host, port and path are stored separately, in
   the clear, because they are not secrets.
3. **Verify access.** This is the only moment the server will accept an unknown
   host identity. It connects, records the server's SHA256 host-key fingerprint,
   and runs one catalog command. Compare the recorded fingerprint with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server — the
   formats are identical.
4. **After that, the pin is enforced.** A normal agent run against an unpinned
   or changed host key is refused before authentication, so a redirected or
   impersonated server never receives the key.

Requirements on the server: WP-CLI on `PATH` (or an absolute `wpBinary`), and an
sshd offering a CTR cipher — Deno's `node:crypto` cannot drive the AES-GCM path
`ssh2` uses, so GCM is excluded from negotiation rather than left to chance.

**What SSH can and cannot do here.** The agent can run only the fixed catalog in
`supabase/functions/_shared/wpCliCatalog.ts` — version, checksum, plugin, theme,
user-count and non-sensitive option reads. There is no free-text command field
anywhere in the path: the browser sends a catalog id and at most one bounded
parameter, and every token in the composed command line is re-validated against
a strict allowlist server-side. Mutating verbs (`install`, `update`, `delete`,
`activate`, `deactivate`, `regenerate`, `run`, `eval`) are rejected by a guard
that also runs over the catalog itself, so a mutating command cannot be added by
mistake. Sensitive options (`auth_key`, `*_salt`, anything matching
password/secret/token/api key) are refused. Output is truncated at 64 KB, stripped
of terminal control codes, scrubbed of long secret-shaped tokens, and every run
is bounded by a 45 s ceiling. `wordpress.execute_wp_cli` — the write path —
remains unimplemented.

Run `npm run check:wpcli` to execute this safety model rather than trust it.

### Server-side reasoning

Optional, additive, read-only. The reasoning layer decides *which known
inspection happens next* and *how it is explained*; it never decides what the
system is capable of.

1. **Set the model credential** as an Edge Function secret: `ANTHROPIC_API_KEY`
   for the Claude models, `LOVABLE_API_KEY` for the built-in ones. Both are
   server-side only. The browser holds no model credential and never calls a
   model.
2. **Deploy `agent-reason`.** It proves the caller belongs to the project,
   sanitizes the digest the browser sent — redacting pasted passwords, tokens
   and long secret-shaped strings — and asks the model for a next turn.

**Which model thinks.** The choice is a single operator-level default in
Settings, drawn from the closed list in
`supabase/functions/_shared/reasonModels.ts` (Claude Sonnet by default, plus
Claude Haiku and the built-in Gemini and GPT models). The browser sends an id
and nothing more: the server decides what that id means, which provider it
calls and which secret it uses. An unknown id falls back to the default. A
model choice changes *who thinks*, never *what the agent may do* — every
answer still has to survive the same closed step catalog below.

**What the model can and cannot do.** It chooses step ids from the closed
catalog in `supabase/functions/_shared/reasonCatalog.ts`, and nothing else. It
cannot invent a tool, a command, an argument, a URL or an access type; it
cannot choose a step whose access the run does not already hold; it cannot both
act and wait for access; it is bounded to four steps per turn; and everything
it writes is truncated plain English. The browser then rebuilds each real
action from the tool registry, so the invocation key, arguments, capability and
risk are always system-authored. Policy and the execution gateway still gate
everything afterwards, exactly as before. No change can be planned here: the
catalog contains read-only tools only.

**Failure is a normal path.** If the function is not deployed, the key is
missing, the model is rate limited or out of credits, the call times out, or
the answer falls outside the catalog, the deterministic operator takes the turn
instead and the run continues.

Run `npm run check:reasoner` to execute this boundary rather than trust it.

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
- `LOVABLE_API_KEY` — built-in model access for `agent-reason` only
- `ANTHROPIC_API_KEY` — Claude access for `agent-reason` only

The SSH private key and its passphrase are sealed with
`AGENT_SECRET_ENCRYPTION_KEY` and never leave the server. `host`, `port`,
`wpRoot`, `wpBinary` and `host_fingerprint` are deliberately **not** secrets and
are stored in plain columns so a pin change is auditable.

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
   200 response. For SSH, the equivalent proof is a real authenticated
   connection to the pinned host plus a catalog command that exited 0 — a
   non-zero exit is a failure, not evidence, and never marks access verified.

`last_verified_at` stays null until then. The agent says "stored securely"
before verification and "verified" only after, and it distinguishes stored from
verified capabilities when deciding what it may attempt.
