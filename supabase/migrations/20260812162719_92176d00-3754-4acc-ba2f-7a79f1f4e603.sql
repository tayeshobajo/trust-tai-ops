create table if not exists public.conversation_anchors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  source_message_id uuid not null references public.project_messages(id) on delete cascade,
  anchor_type text not null check (anchor_type in ('option_set','option','decision','commitment','reference')),
  label text not null,
  normalized_label text not null,
  aliases text[] not null default '{}',
  summary text not null default '',
  ordinal integer not null default -1,
  created_at timestamptz not null default now()
);

grant select on public.conversation_anchors to authenticated;
grant all on public.conversation_anchors to service_role;

alter table public.conversation_anchors enable row level security;

create unique index if not exists conversation_anchors_unique_idx
  on public.conversation_anchors (source_message_id, normalized_label);
create index if not exists conversation_anchors_project_idx
  on public.conversation_anchors (project_id, created_at desc);

create policy conversation_anchors_read_same_org
  on public.conversation_anchors
  for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = conversation_anchors.project_id
        and p.organization_id = private.current_organization_id()
    )
  );

create table if not exists public.message_references (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  message_id uuid not null references public.project_messages(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  anchor_id uuid references public.conversation_anchors(id) on delete set null,
  source_message_id uuid not null references public.project_messages(id) on delete cascade,
  source_run_id uuid references public.runs(id) on delete set null,
  resolution_method text not null check (resolution_method in ('anchor_exact','anchor_alias','lexical','temporal','none')),
  confidence numeric not null default 0,
  label text not null default '',
  summary text not null default '',
  created_at timestamptz not null default now()
);

grant select on public.message_references to authenticated;
grant all on public.message_references to service_role;

alter table public.message_references enable row level security;

create unique index if not exists message_references_unique_idx
  on public.message_references (message_id, source_message_id);
create index if not exists message_references_project_idx
  on public.message_references (project_id, created_at desc);

create policy message_references_read_same_org
  on public.message_references
  for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = message_references.project_id
        and p.organization_id = private.current_organization_id()
    )
  );

-- Lexical recall runs over a bounded, project-scoped window of recent
-- messages, so this ordering index is the one the search actually needs.
create index if not exists project_messages_project_recent_idx
  on public.project_messages (project_id, created_at desc);