-- Two tables required by live code but missing from migrations.
-- Idempotent: safe to apply more than once.
--
-- 1. run_plans  — the agent's living working plan (AGENT_SYSTEM_THINKING Pass 1)
--    One row per run. The orchestrator upserts on run_id. The right rail reads
--    it. Without this table every loadRunPlan / saveRunPlan call silently fails
--    and the right rail stays empty.
--
-- 2. knowledge_base_entries  — global incident pattern library (Pass 7 / KB recall)
--    No project_id column: intentionally global so patterns learned on one site
--    inform work on another. Reads and writes route exclusively through
--    agent-execute with service-role; the browser never touches this table.

begin;

-- 1. run_plans ---------------------------------------------------------------

create table if not exists public.run_plans (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  run_id       uuid not null references public.runs(id)    on delete cascade,
  goal         text not null default '',
  hypotheses   jsonb not null default '[]'::jsonb,
  steps        jsonb not null default '[]'::jsonb,
  -- Monotonic revision counter so a stale write can be detected.
  revision     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One plan per run (upsert target).
create unique index if not exists run_plans_run_id_idx
  on public.run_plans (run_id);

-- Fast lookup from the project side.
create index if not exists run_plans_project_id_idx
  on public.run_plans (project_id);

alter table public.run_plans enable row level security;

-- Members of the owning org may read and write the plan.
-- Writes always flow from the server (service role bypasses RLS), but the
-- anon/authenticated path is kept tight: can_reach_project for read,
-- can_write_project for mutations.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'run_plans' and policyname = 'run_plans_member_read'
  ) then
    create policy run_plans_member_read
      on public.run_plans for select to authenticated
      using (private.can_reach_project(project_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'run_plans' and policyname = 'run_plans_member_write'
  ) then
    create policy run_plans_member_write
      on public.run_plans for insert to authenticated
      with check (private.can_write_project(project_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'run_plans' and policyname = 'run_plans_member_update'
  ) then
    create policy run_plans_member_update
      on public.run_plans for update to authenticated
      using  (private.can_write_project(project_id))
      with check (private.can_write_project(project_id));
  end if;
end
$$;

grant select, insert, update on public.run_plans to authenticated;
grant all on public.run_plans to service_role;


-- 2. knowledge_base_entries --------------------------------------------------
-- Global, not project-scoped. No RLS needed beyond service-role isolation:
-- anon and authenticated are granted nothing; only the service role (used
-- exclusively by agent-execute after proving project ownership) may read/write.

create table if not exists public.knowledge_base_entries (
  id                  uuid primary key default gen_random_uuid(),
  task_type           text not null,
  -- Normalised, lowercased symptom description used for fuzzy dedup.
  symptom_pattern     text not null,
  resolution          text not null default '',
  -- JSON array of signal strings (plugin names, error codes, etc.).
  evidence_signals    jsonb not null default '[]'::jsonb,
  -- Tool ids that proved useful for this pattern.
  tools_used          jsonb not null default '[]'::jsonb,
  -- Optional host/stack context (e.g. "Nginx, WP Engine").
  host_context        text,
  -- How many projects this pattern has been confirmed on.
  project_count       integer not null default 1,
  last_confirmed_at   timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

-- Searches are always by task_type first.
create index if not exists knowledge_base_entries_task_type_idx
  on public.knowledge_base_entries (task_type);

-- Most-recently-confirmed entries come first.
create index if not exists knowledge_base_entries_confirmed_idx
  on public.knowledge_base_entries (last_confirmed_at desc);

alter table public.knowledge_base_entries enable row level security;

-- No policies for authenticated / anon: every access is via service role only.
-- agent-execute proves project ownership before reading or writing.
grant all on public.knowledge_base_entries to service_role;

commit;
