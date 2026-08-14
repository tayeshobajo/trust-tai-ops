-- Cross-project incident library.
--
-- A global (non-project-scoped) procedure table: a fix learned from one
-- project is available to every future run of the same task type.
-- Written by the orchestrator at sufficient_evidence; read by the reasoner
-- to seed the digest with prior resolutions before the first turn.

create table if not exists public.knowledge_base_entries (
  id                  uuid        not null default gen_random_uuid() primary key,
  scope               text        not null default 'global',
  task_type           text        not null,
  symptom_pattern     text        not null,
  resolution          text        not null,
  evidence_signals    jsonb       not null default '[]'::jsonb,
  tools_used          jsonb       not null default '[]'::jsonb,
  host_context        text,
  project_count       integer     not null default 1,
  last_confirmed_at   timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes for the two query paths: task-type lookup and host-context filter.
create index if not exists idx_kb_entries_task_type
  on public.knowledge_base_entries (task_type);

create index if not exists idx_kb_entries_host_context
  on public.knowledge_base_entries (host_context)
  where host_context is not null;

-- RLS: service-role only. No anon policies — this table is never read by
-- an anonymous browser; the reasoner edge function uses the service role.
alter table public.knowledge_base_entries enable row level security;

-- updated_at trigger (reuse the pattern from other tables in this schema).
create or replace function public.handle_kb_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_kb_updated_at on public.knowledge_base_entries;
create trigger trg_kb_updated_at
  before update on public.knowledge_base_entries
  for each row execute function public.handle_kb_updated_at();
