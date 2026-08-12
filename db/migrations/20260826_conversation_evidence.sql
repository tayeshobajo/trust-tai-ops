-- Conversation evidence intake.
--
-- A person can attach the evidence itself to a project conversation: a
-- screenshot, a recording, a PDF, a log, a HAR. The object lives in a private
-- storage bucket; this schema holds only its provenance and the normalized,
-- bounded analysis derived from it.
--
-- Safe to apply twice: every statement is guarded.

begin;

-- 1. Evidence ---------------------------------------------------------------
create table if not exists public.project_evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  message_id uuid references project_messages(id) on delete set null,
  run_id uuid references runs(id) on delete set null,
  uploaded_by uuid,
  original_filename text not null default 'attachment',
  safe_filename text not null default 'attachment',
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  storage_bucket text not null default 'project-evidence',
  storage_path text not null,
  evidence_kind text not null default 'other'
    check (evidence_kind in ('image', 'video', 'pdf', 'text', 'log', 'har', 'json', 'csv', 'other')),
  status text not null default 'uploading'
    check (status in ('uploading', 'stored', 'analyzing', 'ready', 'failed', 'unsupported')),
  content_hash text,
  analysis_id uuid,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.project_evidence add column if not exists analysis_id uuid;
alter table public.project_evidence add column if not exists failure_reason text;
alter table public.project_evidence add column if not exists content_hash text;

create index if not exists project_evidence_project_idx on public.project_evidence (project_id, created_at desc);
create index if not exists project_evidence_message_idx on public.project_evidence (message_id);
create index if not exists project_evidence_run_idx on public.project_evidence (run_id);
-- Retrying the same upload against the same message must not create a second
-- record. A file legitimately re-attached to a *different* message still can.
create unique index if not exists project_evidence_dedupe_idx
  on public.project_evidence (project_id, message_id, content_hash)
  where content_hash is not null and message_id is not null;
create unique index if not exists project_evidence_storage_path_idx
  on public.project_evidence (storage_bucket, storage_path);

-- 2. Normalized analysis ----------------------------------------------------
create table if not exists public.evidence_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evidence_id uuid not null references project_evidence(id) on delete cascade,
  version integer not null default 1,
  analyzer text not null default 'text_reader',
  model_id text not null default '',
  status text not null default 'complete'
    check (status in ('complete', 'failed', 'unavailable', 'unsupported')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists evidence_analyses_version_key on public.evidence_analyses (evidence_id, version);
create index if not exists evidence_analyses_project_idx on public.evidence_analyses (project_id, created_at desc);

-- 3. Data API grants --------------------------------------------------------
-- PostgREST grants nothing on public by default. Reads are scoped to the
-- caller's own organization by the policies below; every write goes through
-- the `evidence-intake` edge function under service_role.
grant select on public.project_evidence to authenticated;
grant all on public.project_evidence to service_role;
grant select on public.evidence_analyses to authenticated;
grant all on public.evidence_analyses to service_role;

-- 4. Row level security -----------------------------------------------------
alter table public.project_evidence enable row level security;
alter table public.evidence_analyses enable row level security;

drop policy if exists project_evidence_member_read on public.project_evidence;
create policy project_evidence_member_read
  on public.project_evidence for select to authenticated
  using (private.can_reach_project(project_id));

drop policy if exists evidence_analyses_member_read on public.evidence_analyses;
create policy evidence_analyses_member_read
  on public.evidence_analyses for select to authenticated
  using (private.can_reach_project(project_id));

commit;
