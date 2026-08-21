-- Captain Plan Request Queue — Phase 1 of the Captain × Ops execution loop.
--
-- The browser submits a client task; the edge function enqueues a request for
-- the REAL Captain (OpenClaw on Tai's laptop). A local daemon polls pending
-- rows, invokes Captain with tools, and writes the structured plan back with
-- the service role. The edge function long-polls for the answer.
--
-- Until the daemon answers, the edge function falls back to the prompt-based
-- Captain (today's behavior) — never a hard failure.
--
-- Idempotent: safe to apply more than once.

begin;

create table if not exists public.captain_plan_requests (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  run_id         uuid references public.runs(id) on delete set null,
  -- The sanitized task digest exactly as the edge function received it.
  digest         jsonb not null default '{}'::jsonb,
  -- pending | in_progress | done | failed | expired
  status         text not null default 'pending'
                   check (status in ('pending', 'in_progress', 'done', 'failed', 'expired')),
  -- Where the winning answer came from.
  -- openclaw  = the real Captain (daemon answered)
  -- fallback  = prompt-Captain inside the edge function
  source         text check (source in ('openclaw', 'fallback')),
  plan           jsonb,
  error_summary  text,
  -- Daemon heartbeat fields.
  claimed_at     timestamptz,
  answered_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists captain_plan_requests_pending_idx
  on public.captain_plan_requests (status, created_at)
  where status = 'pending';

create index if not exists captain_plan_requests_project_idx
  on public.captain_plan_requests (project_id, created_at desc);

alter table public.captain_plan_requests enable row level security;

-- The browser never touches this table directly. Reads/writes happen with the
-- service role inside edge functions. No policies = default deny for
-- authenticated/anon. (Same posture as knowledge_base_entries.)

comment on table public.captain_plan_requests is
  'Queue routing client tasks to the real Captain (OpenClaw daemon) with prompt fallback.';

commit;
