-- Trust Tai Ops — agent execution audit trail.
-- Idempotent: safe to run against an existing database more than once.

create table if not exists public.agent_execution_events (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  run_id text,
  tool_id text not null,
  invocation_key text not null,
  status text not null,
  risk text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  input_summary text not null default '',
  output_summary text not null default '',
  error_code text,
  evidence_refs jsonb not null default '[]'::jsonb,
  evidence_data jsonb,
  created_at timestamptz not null default now()
);

-- Idempotency: one record per planned invocation, per project.
create unique index if not exists agent_execution_events_invocation_key_idx
  on public.agent_execution_events (project_id, invocation_key);

create index if not exists agent_execution_events_run_idx
  on public.agent_execution_events (project_id, run_id, started_at);

grant select, insert, update on public.agent_execution_events to authenticated;
grant select, insert, update on public.agent_execution_events to anon;
grant all on public.agent_execution_events to service_role;

alter table public.agent_execution_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_execution_events'
      and policyname = 'agent_execution_events_read'
  ) then
    create policy agent_execution_events_read
      on public.agent_execution_events for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_execution_events'
      and policyname = 'agent_execution_events_write'
  ) then
    create policy agent_execution_events_write
      on public.agent_execution_events for insert with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_execution_events'
      and policyname = 'agent_execution_events_update'
  ) then
    create policy agent_execution_events_update
      on public.agent_execution_events for update using (true) with check (true);
  end if;
end $$;
