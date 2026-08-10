-- Trust Tai Ops — server-only credential store + audit-trail lockdown.
-- Idempotent: safe to run against an existing database more than once.
--
-- Two things happen here:
--   1. A service-role-only table for encrypted access credentials. No browser
--      role is granted anything on it, so a secret can never be selected back.
--   2. The execution audit trail loses its anonymous write access and its
--      permissive `using (true)` policies, and now fails closed unless the
--      caller is proven to belong to the organization owning the project.

-- ---------------------------------------------------------------------------
-- Membership proof (security definer so policies never recurse into RLS).
-- ---------------------------------------------------------------------------

create or replace function public.current_member_organization()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.organization_id
  from public.users u
  join auth.users au on lower(au.email) = lower(u.email)
  where au.id = auth.uid()
    and u.status <> 'disabled'
  limit 1
$$;

create or replace function public.can_access_project(_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = _project_id
      and p.organization_id = public.current_member_organization()
  )
$$;

revoke all on function public.current_member_organization() from public, anon;
revoke all on function public.can_access_project(uuid) from public, anon;
grant execute on function public.current_member_organization() to authenticated;
grant execute on function public.can_access_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Encrypted credential store. Ciphertext only; never a plaintext column.
-- ---------------------------------------------------------------------------

create table if not exists public.project_access_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  access_type text not null check (access_type in ('wordpress_admin', 'sftp', 'ssh', 'hosting_portal', 'database', 'cdn')),
  provider text not null,
  username text not null,
  ciphertext text not null,
  iv text not null,
  algorithm text not null,
  key_version text not null,
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'verified', 'rejected')),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, access_type)
);

-- Deliberately no grants to anon or authenticated: the only reader is the
-- service role inside an edge function.
revoke all on public.project_access_secrets from anon;
revoke all on public.project_access_secrets from authenticated;
grant all on public.project_access_secrets to service_role;

alter table public.project_access_secrets enable row level security;

-- No policy for anon/authenticated exists, so RLS denies them outright even if
-- a grant is ever added by mistake.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'project_access_secrets'
      and policyname = 'project_access_secrets_service_only'
  ) then
    create policy project_access_secrets_service_only
      on public.project_access_secrets
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Audit trail lockdown.
-- ---------------------------------------------------------------------------

drop policy if exists agent_execution_events_read on public.agent_execution_events;
drop policy if exists agent_execution_events_write on public.agent_execution_events;
drop policy if exists agent_execution_events_update on public.agent_execution_events;

revoke all on public.agent_execution_events from anon;
revoke insert, update, delete on public.agent_execution_events from authenticated;
grant select on public.agent_execution_events to authenticated;
grant all on public.agent_execution_events to service_role;

alter table public.agent_execution_events enable row level security;

do $$
begin
  -- Members may read their own organization's execution history. Anything the
  -- membership lookup cannot prove is invisible.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_execution_events'
      and policyname = 'agent_execution_events_member_read'
  ) then
    create policy agent_execution_events_member_read
      on public.agent_execution_events
      for select
      to authenticated
      using (public.can_access_project(project_id::uuid));
  end if;

  -- Writes belong to the execution gateway, which runs as the service role.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_execution_events'
      and policyname = 'agent_execution_events_service_write'
  ) then
    create policy agent_execution_events_service_write
      on public.agent_execution_events
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;
