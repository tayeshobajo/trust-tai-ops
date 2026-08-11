-- Meeting transcripts as project sources, the analyses derived from them, and
-- the proposals a human still has to approve.
--
-- Safe to apply to an already-created Trust Tai Ops database: every statement
-- is guarded so re-running the migration is a no-op.

begin;

-- 1. Sources ----------------------------------------------------------------
create table if not exists project_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_type text not null default 'meeting_transcript' check (source_type in ('meeting_transcript')),
  title text not null default 'Client meeting transcript',
  occurred_at timestamptz,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid,
  original_filename text,
  storage_kind text not null default 'inline_text' check (storage_kind in ('inline_text', 'object_ref')),
  raw_ref text,
  normalized_text text not null default '',
  redaction_report jsonb not null default '{}'::jsonb,
  content_hash text not null,
  byte_size integer not null default 0,
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'analyzing', 'analyzed', 'failed')),
  created_at timestamptz not null default now()
);

create unique index if not exists project_sources_hash_key on project_sources (project_id, content_hash);
create index if not exists project_sources_project_idx on project_sources (project_id, uploaded_at desc);

-- 2. Analyses ---------------------------------------------------------------
create table if not exists source_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_id uuid not null references project_sources(id) on delete cascade,
  version integer not null default 1,
  mode text not null default 'analyze_meeting_source',
  model_id text not null default '',
  prompt_version text not null default '',
  status text not null default 'complete' check (status in ('complete', 'failed')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists source_analyses_version_key on source_analyses (source_id, version);

-- 3. Proposed tasks ---------------------------------------------------------
create table if not exists proposed_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  analysis_id uuid not null references source_analyses(id) on delete cascade,
  source_id uuid not null references project_sources(id) on delete cascade,
  task_key text not null,
  title text not null,
  client_ask text not null default '',
  provenance jsonb not null default '[]'::jsonb,
  task_type text not null default 'qa_only',
  risk_level text not null default 'cautious',
  needs_investigation boolean not null default false,
  access_needed text[] not null default '{}',
  depends_on text[] not null default '{}',
  implementation_approach text not null default '',
  verification_expectation text not null default '',
  requires_execution_approval boolean not null default true,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'edited', 'superseded')),
  decided_by uuid,
  decided_at timestamptz,
  run_id uuid references runs(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists proposed_tasks_key on proposed_tasks (project_id, task_key);
create index if not exists proposed_tasks_project_idx on proposed_tasks (project_id, created_at desc);

-- 4. Memory candidates ------------------------------------------------------
create table if not exists memory_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  analysis_id uuid not null references source_analyses(id) on delete cascade,
  source_id uuid not null references project_sources(id) on delete cascade,
  candidate_key text not null,
  kind text not null default 'uncertain' check (kind in ('durable', 'task_detail', 'uncertain')),
  title text not null,
  content text not null default '',
  memory_type text not null default 'stack_note',
  importance text not null default 'medium',
  supersedes_memory_id uuid,
  provenance jsonb not null default '[]'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'superseded')),
  created_at timestamptz not null default now()
);

create unique index if not exists memory_candidates_key on memory_candidates (project_id, candidate_key);

-- 5. Provenance on existing records -----------------------------------------
alter table project_memory_entries add column if not exists source_id uuid;
alter table project_memory_entries add column if not exists source_excerpt text;
alter table project_memory_entries add column if not exists superseded_by uuid;

alter table runs add column if not exists origin_source_id uuid;
alter table runs add column if not exists origin_proposed_task_id uuid;

-- 6. Data API grants --------------------------------------------------------
-- PostgREST grants nothing on public by default. Every policy below scopes to
-- the signed-in caller's organization, so anon gets nothing.
grant select, insert, update, delete on public.project_sources to authenticated;
grant all on public.project_sources to service_role;
grant select, insert, update, delete on public.source_analyses to authenticated;
grant all on public.source_analyses to service_role;
grant select, insert, update, delete on public.proposed_tasks to authenticated;
grant all on public.proposed_tasks to service_role;
grant select, insert, update, delete on public.memory_candidates to authenticated;
grant all on public.memory_candidates to service_role;

-- 7. Row level security -----------------------------------------------------
alter table project_sources enable row level security;
alter table source_analyses enable row level security;
alter table proposed_tasks enable row level security;
alter table memory_candidates enable row level security;

-- Membership check shared by every policy below. A project is reachable only
-- through the caller's own organization, so cross-project reads are impossible.
create or replace function public.can_reach_project(_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from projects p
    join users u on u.organization_id = p.organization_id
    where p.id = _project_id
      and (u.auth_user_id = auth.uid() or lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
      and coalesce(u.status, 'active') <> 'disabled'
  )
$$;

do $$
declare
  target text;
begin
  foreach target in array array['project_sources', 'source_analyses', 'proposed_tasks', 'memory_candidates']
  loop
    execute format('drop policy if exists %I on %I', target || '_member_read', target);
    execute format(
      'create policy %I on %I for select to authenticated using (public.can_reach_project(project_id))',
      target || '_member_read', target);

    execute format('drop policy if exists %I on %I', target || '_member_write', target);
    execute format(
      'create policy %I on %I for insert to authenticated with check (public.can_reach_project(project_id))',
      target || '_member_write', target);

    execute format('drop policy if exists %I on %I', target || '_member_update', target);
    execute format(
      'create policy %I on %I for update to authenticated using (public.can_reach_project(project_id)) with check (public.can_reach_project(project_id))',
      target || '_member_update', target);
  end loop;
end $$;

commit;