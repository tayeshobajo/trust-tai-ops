-- 1. Private schema for RLS helper functions (not exposed via PostgREST)
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

alter function public.can_access_project(uuid) set schema private;
alter function public.can_access_project_ref(text) set schema private;
alter function public.can_reach_project(uuid) set schema private;
alter function public.current_organization_id() set schema private;
alter function public.current_member_organization() set schema private;

revoke all on function private.can_access_project(uuid) from public, anon;
revoke all on function private.can_access_project_ref(text) from public, anon;
revoke all on function private.can_reach_project(uuid) from public, anon;
revoke all on function private.current_organization_id() from public, anon;
revoke all on function private.current_member_organization() from public, anon;

grant execute on function private.can_access_project(uuid) to authenticated, service_role;
grant execute on function private.can_access_project_ref(text) to authenticated, service_role;
grant execute on function private.can_reach_project(uuid) to authenticated, service_role;
grant execute on function private.current_organization_id() to authenticated, service_role;
grant execute on function private.current_member_organization() to service_role;

-- 2. Membership-based write helper
create or replace function private.can_write_project(_project_id uuid)
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
      and coalesce(u.role, 'viewer') in ('operator', 'senior_operator', 'admin')
  )
$$;

revoke all on function private.can_write_project(uuid) from public, anon;
grant execute on function private.can_write_project(uuid) to authenticated, service_role;

-- 3. project_messages access rules
grant select, insert on public.project_messages to authenticated;
grant all on public.project_messages to service_role;
alter table public.project_messages enable row level security;

drop policy if exists project_messages_same_org on public.project_messages;
drop policy if exists project_messages_member_read on public.project_messages;
drop policy if exists project_messages_member_write on public.project_messages;

create policy project_messages_member_read
  on public.project_messages for select to authenticated
  using (private.can_reach_project(project_id));

create policy project_messages_member_write
  on public.project_messages for insert to authenticated
  with check (private.can_write_project(project_id));

-- 4. Write rules for meeting-intelligence tables
do $$
declare
  target text;
begin
  foreach target in array array['project_sources', 'source_analyses', 'proposed_tasks', 'memory_candidates']
  loop
    execute format('grant select, insert, update on public.%I to authenticated', target);
    execute format('grant all on public.%I to service_role', target);

    execute format('drop policy if exists %I on public.%I', target || '_member_write', target);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.can_write_project(project_id))',
      target || '_member_write', target);

    execute format('drop policy if exists %I on public.%I', target || '_member_update', target);
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.can_write_project(project_id)) with check (private.can_write_project(project_id))',
      target || '_member_update', target);
  end loop;
end $$;