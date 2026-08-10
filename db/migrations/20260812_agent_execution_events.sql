-- Trust Tai Ops — agent execution audit trail.
-- Idempotent: safe to run against an existing database more than once.
--
-- Identity columns match the tables they point at: `projects.id` and `runs.id`
-- are uuid, so these are uuid too. A database created before this correction
-- may still hold text columns; `20260816_audit_identity_alignment.sql`
-- reconciles that case without discarding audit history.

create table if not exists public.agent_execution_events (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
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

-- Reads belong to proven organization members, writes belong to the execution
-- gateway running as the service role. Both policies are created by
-- `20260814_private_access_secrets.sql`, which owns the membership helper.
-- Until then RLS is on with no policy, so the table is closed rather than open.
grant select on public.agent_execution_events to authenticated;
grant all on public.agent_execution_events to service_role;

alter table public.agent_execution_events enable row level security;
