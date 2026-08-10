-- Persistent Conversation layer.
-- Safe to apply to an already-created Trust Tai Ops database: every statement
-- is guarded so re-running the migration is a no-op.

begin;

-- 1. Conversation record -----------------------------------------------------
create table if not exists project_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  role text not null check (role in ('user', 'agent', 'system')),
  kind text not null check (kind in ('message', 'status_update', 'decision_request', 'decision_response')),
  body text[] not null default '{}',
  dedupe_key text,
  source_key text,
  created_at timestamptz not null default now()
);

-- Columns are added individually so a partially-created table is repaired too.
alter table project_messages add column if not exists run_id uuid references runs(id) on delete set null;
alter table project_messages add column if not exists dedupe_key text;
alter table project_messages add column if not exists source_key text;
alter table project_messages add column if not exists created_at timestamptz not null default now();

create index if not exists project_messages_project_created_idx
  on project_messages (project_id, created_at);

create index if not exists project_messages_run_created_idx
  on project_messages (run_id, created_at);

create unique index if not exists project_messages_dedupe_idx
  on project_messages (project_id, dedupe_key)
  where dedupe_key is not null;

-- 2. Memory provenance (optional; existing rows stay null) -------------------
alter table project_memory_entries
  add column if not exists source_run_id uuid references runs(id) on delete set null;
alter table project_memory_entries
  add column if not exists source_message_id uuid references project_messages(id) on delete set null;

-- 3. Row level security ------------------------------------------------------
alter table project_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'project_messages'
      and policyname = 'project_messages_same_org'
  ) then
    execute $policy$
      create policy project_messages_same_org
      on project_messages
      for all
      using (
        exists (
          select 1 from projects p
          where p.id = project_messages.project_id
            and p.organization_id = current_organization_id()
        )
      )
      with check (
        exists (
          select 1 from projects p
          where p.id = project_messages.project_id
            and p.organization_id = current_organization_id()
            and can_write_ops()
        )
      )
    $policy$;
  end if;
end
$$;

-- 4. Grants required by the current adapter ----------------------------------
grant select, insert on project_messages to authenticated;
grant all on project_messages to service_role;

commit;
