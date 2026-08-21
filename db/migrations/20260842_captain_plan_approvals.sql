-- Captain Plan Approval Gate — Phase 2 of the Captain × Ops execution loop.
--
-- The human trust boundary: nothing executes until an authenticated team
-- member approves a plan. Approvals are their own table (not
-- agent_execution_events, which is tool-invocation shaped) because an
-- approval is a human decision on a plan request with a different lifecycle:
-- one row per request, terminal, never overwritten.
--
-- Identity is recorded server-side by the edge function from the VERIFIED
-- bearer token (authorizeProject → auth.uid()). The browser can never name a
-- decider; it can only be one.
--
-- The queue row status is extended so the daemon can claim approved work:
--   done → approved → executing → executed | execution_failed
--   done → rejected (terminal — no execution ever fires)
--
-- Idempotent: safe to apply more than once.

begin;

-- 1. Approvals table ---------------------------------------------------------
create table if not exists public.captain_plan_approvals (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.captain_plan_requests(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- approved | rejected
  decision    text not null check (decision in ('approved', 'rejected')),
  -- Optional reject reason. Phase 4 makes this a real revision loop.
  comment     text,
  -- The authenticated human who decided. auth.uid() from the verified
  -- session, written by the edge function — never client-supplied.
  decided_by  uuid not null,
  decided_by_email text,
  created_at  timestamptz not null default now()
);

-- One decision per request. A second approve click hits this constraint and
-- is treated as a no-op (200), not an error.
create unique index if not exists captain_plan_approvals_request_idx
  on public.captain_plan_approvals (request_id);

create index if not exists captain_plan_approvals_project_idx
  on public.captain_plan_approvals (project_id, created_at desc);

alter table public.captain_plan_approvals enable row level security;

-- The browser never touches this table directly. Writes happen in the edge
-- function with the service role AFTER authorizeProject proves the caller
-- belongs to the project. Reads happen in agent-reason (captain_plan_check)
-- the same way. No policies = default deny for authenticated/anon — same
-- posture as captain_plan_requests.

grant all on public.captain_plan_approvals to service_role;

-- 2. Queue status extension ---------------------------------------------------
-- pending | in_progress | done | failed | expired (Phase 1)
--   + approved | rejected | executing | executed | execution_failed (Phase 2)

-- Drop and recreate the check constraint with the extended set. The original
-- constraint is inline (unnamed on some installs) — find it by definition.
do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.captain_plan_requests'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';
  if constraint_name is not null then
    execute format('alter table public.captain_plan_requests drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.captain_plan_requests
  add constraint captain_plan_requests_status_check
  check (status in (
    'pending', 'in_progress', 'done', 'failed', 'expired',
    'approved', 'rejected', 'executing', 'executed', 'execution_failed'
  ));

-- Daemon claim index for approved rows.
create index if not exists captain_plan_requests_approved_idx
  on public.captain_plan_requests (status, created_at)
  where status = 'approved';

-- 3. Execution audit columns on the queue row --------------------------------
alter table public.captain_plan_requests
  add column if not exists execution_started_at timestamptz,
  add column if not exists execution_finished_at timestamptz,
  add column if not exists execution_summary text;

comment on table public.captain_plan_approvals is
  'Human approval gate for Captain plan requests. One decision per request, recorded with the verified auth uid.';

commit;
