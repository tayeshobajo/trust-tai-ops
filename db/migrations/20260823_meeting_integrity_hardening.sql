-- Meeting intelligence — production integrity hardening.
--
-- Three things change here, and all three exist because a proposal is the
-- moment a conversation turns into work on a live client site:
--
--   1. A proposal now carries who owns it, when it is due, and whether it
--      duplicates or contradicts something the project already has.
--   2. The browser loses every write on the meeting tables. Approval is a
--      server act performed through a locked, idempotent function, so a
--      double-click or a replayed request can never produce two runs.
--   3. Every decision is written to an append-only project event log.
--
-- Safe to re-run: every statement is guarded.

begin;

-- 1. Proposal shape ---------------------------------------------------------
alter table proposed_tasks add column if not exists owner text not null default 'unassigned';
alter table proposed_tasks add column if not exists deadline_text text not null default '';
alter table proposed_tasks add column if not exists due_at timestamptz;
alter table proposed_tasks add column if not exists duplicate_of_run_id uuid references runs(id) on delete set null;
alter table proposed_tasks add column if not exists related_run_id uuid references runs(id) on delete set null;
alter table proposed_tasks add column if not exists conflict_note text not null default '';
-- What the model proposed, and what the human actually approved. Kept apart so
-- an edited approval can never be presented as the model's own suggestion.
alter table proposed_tasks add column if not exists original_proposal jsonb not null default '{}'::jsonb;
alter table proposed_tasks add column if not exists approved_proposal jsonb;
alter table proposed_tasks add column if not exists decision_note text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'proposed_tasks_owner_check'
  ) then
    alter table proposed_tasks
      add constraint proposed_tasks_owner_check
      check (owner in ('us', 'client', 'third_party', 'unassigned'));
  end if;
end $$;

-- 2. Analysis reproducibility ----------------------------------------------
alter table source_analyses add column if not exists context_hash text not null default '';
alter table source_analyses add column if not exists window_count integer not null default 1;
alter table source_analyses add column if not exists coverage jsonb not null default '{}'::jsonb;

-- 3. One run per approved proposal, enforced by the database ----------------
create unique index if not exists runs_origin_proposed_task_key
  on runs (origin_proposed_task_id)
  where origin_proposed_task_id is not null;

-- 4. One memory entry per accepted candidate --------------------------------
alter table project_memory_entries add column if not exists source_candidate_id uuid;
create unique index if not exists project_memory_entries_candidate_key
  on project_memory_entries (source_candidate_id)
  where source_candidate_id is not null;

-- 5. Append-only decision log -----------------------------------------------
create table if not exists public.project_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  event_key text not null,
  event_type text not null,
  actor_user_id uuid,
  subject_id uuid,
  summary text not null default '',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists project_events_key on public.project_events (project_id, event_key);
create index if not exists project_events_project_idx on public.project_events (project_id, created_at desc);

grant select on public.project_events to authenticated;
grant all on public.project_events to service_role;
alter table public.project_events enable row level security;

drop policy if exists project_events_member_read on public.project_events;
create policy project_events_member_read on public.project_events
  for select to authenticated
  using (public.can_reach_project(project_id));

-- 6. The browser reads meeting truth. It never writes it. -------------------
-- Every decision now runs through the meeting-decisions function, which proves
-- membership and then calls the locked functions below as service_role.
revoke insert, update, delete on public.project_sources from authenticated;
revoke insert, update, delete on public.source_analyses from authenticated;
revoke insert, update, delete on public.proposed_tasks from authenticated;
revoke insert, update, delete on public.memory_candidates from authenticated;

do $$
declare
  target text;
begin
  foreach target in array array['project_sources', 'source_analyses', 'proposed_tasks', 'memory_candidates']
  loop
    execute format('drop policy if exists %I on %I', target || '_member_write', target);
    execute format('drop policy if exists %I on %I', target || '_member_update', target);
  end loop;
end $$;

-- 7. Decision functions -----------------------------------------------------
-- Idempotent by construction: the proposal row is locked, the terminal state is
-- returned unchanged, and the unique index above is the last line of defence.

create or replace function public.meeting_record_event(
  _project_id uuid,
  _event_key text,
  _event_type text,
  _actor uuid,
  _subject uuid,
  _summary text,
  _detail jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.project_events (project_id, event_key, event_type, actor_user_id, subject_id, summary, detail)
  values (_project_id, _event_key, _event_type, _actor, _subject, coalesce(_summary, ''), coalesce(_detail, '{}'::jsonb))
  on conflict (project_id, event_key) do nothing;
$$;

create or replace function public.meeting_approve_proposal(
  _proposal_id uuid,
  _actor uuid,
  _run jsonb,
  _phases jsonb,
  _approved_proposal jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  proposal proposed_tasks%rowtype;
  new_run_id uuid;
  phase jsonb;
begin
  select * into proposal from proposed_tasks where id = _proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;

  -- Already decided. Return the run that exists rather than creating a second.
  if proposal.run_id is not null then
    return proposal.run_id;
  end if;
  if proposal.status in ('rejected', 'superseded') then
    raise exception 'proposal_already_decided';
  end if;

  new_run_id := coalesce((_run ->> 'id')::uuid, gen_random_uuid());

  insert into runs (
    id, project_id, environment_id, created_by_user_id, title, task_type, task_summary, urgency,
    state, risk_level, backup_status, approval_required, next_action, operator_prompt,
    diagnosis_summary, plan_summary, origin_source_id, origin_proposed_task_id
  ) values (
    new_run_id,
    proposal.project_id,
    (_run ->> 'environment_id')::uuid,
    _actor,
    _run ->> 'title',
    _run ->> 'task_type',
    _run ->> 'task_summary',
    _run ->> 'urgency',
    _run ->> 'state',
    _run ->> 'risk_level',
    _run ->> 'backup_status',
    coalesce((_run ->> 'approval_required')::boolean, true),
    _run ->> 'next_action',
    _run ->> 'operator_prompt',
    coalesce(_run ->> 'diagnosis_summary', ''),
    coalesce(_run ->> 'plan_summary', ''),
    proposal.source_id,
    proposal.id
  );

  for phase in select * from jsonb_array_elements(coalesce(_phases, '[]'::jsonb))
  loop
    insert into run_phases (run_id, state, label, summary, status)
    values (new_run_id, phase ->> 'state', phase ->> 'label', coalesce(phase ->> 'summary', ''), phase ->> 'status');
  end loop;

  insert into run_actions (run_id, actor, summary, outcome)
  values (new_run_id, 'operator', 'Approved from a client meeting: ' || proposal.title, 'succeeded');

  update proposed_tasks
     set status = case when _approved_proposal is null then 'approved' else 'edited' end,
         run_id = new_run_id,
         decided_by = _actor,
         decided_at = now(),
         approved_proposal = _approved_proposal
   where id = proposal.id;

  perform public.meeting_record_event(
    proposal.project_id,
    'proposal-approved:' || proposal.id::text,
    'meeting_proposal_approved',
    _actor,
    proposal.id,
    'Approved from a client meeting: ' || proposal.title,
    jsonb_build_object('runId', new_run_id, 'sourceId', proposal.source_id)
  );

  return new_run_id;
end;
$$;

create or replace function public.meeting_reject_proposal(
  _proposal_id uuid,
  _actor uuid,
  _note text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  proposal proposed_tasks%rowtype;
begin
  select * into proposal from proposed_tasks where id = _proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;
  if proposal.run_id is not null then
    raise exception 'proposal_already_started';
  end if;
  if proposal.status = 'rejected' then
    return true;
  end if;

  update proposed_tasks
     set status = 'rejected',
         decided_by = _actor,
         decided_at = now(),
         decision_note = coalesce(_note, '')
   where id = proposal.id;

  perform public.meeting_record_event(
    proposal.project_id,
    'proposal-rejected:' || proposal.id::text,
    'meeting_proposal_rejected',
    _actor,
    proposal.id,
    'Left alone: ' || proposal.title,
    jsonb_build_object('sourceId', proposal.source_id)
  );

  return true;
end;
$$;

create or replace function public.meeting_decide_memory_candidate(
  _candidate_id uuid,
  _actor uuid,
  _accepted boolean
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate memory_candidates%rowtype;
  entry_id uuid;
  excerpt text;
begin
  select * into candidate from memory_candidates where id = _candidate_id for update;
  if not found then
    raise exception 'candidate_not_found';
  end if;

  if not _accepted then
    update memory_candidates set status = 'rejected' where id = candidate.id and status = 'pending';
    perform public.meeting_record_event(
      candidate.project_id,
      'memory-rejected:' || candidate.id::text,
      'meeting_memory_rejected',
      _actor,
      candidate.id,
      'Did not keep: ' || candidate.title,
      jsonb_build_object('sourceId', candidate.source_id)
    );
    return null;
  end if;

  select id into entry_id from project_memory_entries where source_candidate_id = candidate.id;
  if entry_id is not null then
    return entry_id;
  end if;

  excerpt := coalesce(candidate.provenance -> 0 ->> 'excerpt', '');

  insert into project_memory_entries (
    project_id, memory_type, importance, title, content, source_id, source_excerpt, source_candidate_id
  ) values (
    candidate.project_id, candidate.memory_type, candidate.importance, candidate.title, candidate.content,
    candidate.source_id, excerpt, candidate.id
  )
  returning id into entry_id;

  if candidate.supersedes_memory_id is not null then
    update project_memory_entries
       set superseded_by = entry_id, updated_at = now()
     where id = candidate.supersedes_memory_id;
  end if;

  update memory_candidates set status = 'accepted' where id = candidate.id;

  perform public.meeting_record_event(
    candidate.project_id,
    'memory-accepted:' || candidate.id::text,
    'meeting_memory_accepted',
    _actor,
    candidate.id,
    'Remembered: ' || candidate.title,
    jsonb_build_object('memoryId', entry_id, 'sourceId', candidate.source_id)
  );

  return entry_id;
end;
$$;

-- These are server acts. No browser role may call them.
revoke all on function public.meeting_record_event(uuid, text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.meeting_approve_proposal(uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.meeting_reject_proposal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.meeting_decide_memory_candidate(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.meeting_record_event(uuid, text, text, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.meeting_approve_proposal(uuid, uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.meeting_reject_proposal(uuid, uuid, text) to service_role;
grant execute on function public.meeting_decide_memory_candidate(uuid, uuid, boolean) to service_role;

commit;