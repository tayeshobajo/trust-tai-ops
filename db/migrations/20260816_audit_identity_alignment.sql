-- Trust Tai Ops — audit trail identity alignment.
--
-- `agent_execution_events` was originally declared with text identity columns
-- while `projects.id` and `runs.id` are uuid. This migration reconciles a
-- database created under the old shape, and is a no-op on a fresh one.
--
-- Rules it obeys:
--   * Never cast arbitrary text to uuid. A single unconvertible value would
--     abort the migration, and inside an RLS policy it would abort every read.
--   * Never discard audit history. If any row cannot be proven convertible the
--     column is left as text and the safe text-comparison policy stays in
--     place, so the table keeps working and keeps its rows.
--   * Idempotent. Running it twice changes nothing the second time.

-- ---------------------------------------------------------------------------
-- project_id: text -> uuid, only when every existing row is provably a uuid.
-- ---------------------------------------------------------------------------

do $$
declare
  column_type text;
  unconvertible bigint;
begin
  select data_type into column_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'agent_execution_events'
    and column_name = 'project_id';

  if column_type is null then
    return; -- Table does not exist yet; the create migration owns the shape.
  end if;

  if column_type <> 'text' then
    return; -- Already aligned.
  end if;

  select count(*) into unconvertible
  from public.agent_execution_events
  where project_id is null
     or project_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if unconvertible > 0 then
    raise notice
      'agent_execution_events.project_id left as text: % row(s) are not uuid-shaped. History preserved; the RLS policy compares as text.',
      unconvertible;
    return;
  end if;

  -- Every row is provably castable, so this cannot fail.
  alter table public.agent_execution_events
    alter column project_id type uuid using project_id::uuid;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.agent_execution_events'::regclass
      and contype = 'f'
      and conname = 'agent_execution_events_project_id_fkey'
  ) then
    alter table public.agent_execution_events
      add constraint agent_execution_events_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- run_id: text -> uuid. Nullable, and a null is convertible.
-- ---------------------------------------------------------------------------

do $$
declare
  column_type text;
  unconvertible bigint;
begin
  select data_type into column_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'agent_execution_events'
    and column_name = 'run_id';

  if column_type is null or column_type <> 'text' then
    return;
  end if;

  select count(*) into unconvertible
  from public.agent_execution_events
  where run_id is not null
    and run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if unconvertible > 0 then
    raise notice
      'agent_execution_events.run_id left as text: % row(s) are not uuid-shaped. History preserved.',
      unconvertible;
    return;
  end if;

  alter table public.agent_execution_events
    alter column run_id type uuid using nullif(run_id, '')::uuid;

  -- A run may be deleted while its audit history must survive, so this is
  -- `set null` rather than `cascade`.
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.agent_execution_events'::regclass
      and contype = 'f'
      and conname = 'agent_execution_events_run_id_fkey'
  ) then
    begin
      alter table public.agent_execution_events
        add constraint agent_execution_events_run_id_fkey
        foreign key (run_id) references public.runs(id) on delete set null;
    exception when foreign_key_violation then
      -- Audit rows can outlive their run. Keeping the history matters more
      -- than the constraint, so the column stays uuid without the reference.
      raise notice 'agent_execution_events.run_id kept without a foreign key: some rows reference runs that no longer exist.';
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The read policy must be correct for both shapes.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.agent_execution_events') is null then
    return;
  end if;

  -- Replaces any earlier definition, including one carrying a `::uuid` cast.
  drop policy if exists agent_execution_events_member_read on public.agent_execution_events;
  create policy agent_execution_events_member_read
    on public.agent_execution_events
    for select
    to authenticated
    using (public.can_access_project_ref(project_id::text));
end $$;

-- No permissive policy may come back.
drop policy if exists agent_execution_events_read on public.agent_execution_events;
drop policy if exists agent_execution_events_write on public.agent_execution_events;
drop policy if exists agent_execution_events_update on public.agent_execution_events;

revoke all on public.agent_execution_events from anon;
revoke insert, update, delete on public.agent_execution_events from authenticated;
grant select on public.agent_execution_events to authenticated;
grant all on public.agent_execution_events to service_role;
