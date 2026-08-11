-- 1. Fix mutable search_path on invoker helpers
create or replace function public.auth_email()
returns text language sql stable set search_path = public as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.auth_role()
returns text language sql stable set search_path = public as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', auth.jwt() -> 'user_metadata' ->> 'role', 'viewer')
$$;

create or replace function public.can_write_ops()
returns boolean language sql stable set search_path = public as $$
  select public.auth_role() in ('operator', 'senior_operator', 'admin')
$$;

create or replace function public.can_approve_ops()
returns boolean language sql stable set search_path = public as $$
  select public.auth_role() in ('senior_operator', 'admin')
$$;

-- 2. Stable-ID based organization resolution (email only as transitional fallback)
create or replace function public.current_organization_id()
returns uuid language sql stable security definer set search_path = public as $$
  select organization_id from (
    select u.organization_id, 0 as precedence
    from public.users u
    where u.auth_user_id = auth.uid()
      and coalesce(u.status, 'active') <> 'disabled'
    union all
    select u.organization_id, 1 as precedence
    from public.users u
    join auth.users au on lower(au.email) = lower(u.email)
    where au.id = auth.uid()
      and u.auth_user_id is null
      and coalesce(u.status, 'active') <> 'disabled'
  ) resolved
  order by precedence
  limit 1
$$;

-- 3. Remove anonymous execute on SECURITY DEFINER helpers
revoke all on function public.current_organization_id() from public, anon;
grant execute on function public.current_organization_id() to authenticated, service_role;

revoke all on function public.can_reach_project(uuid) from public, anon;
grant execute on function public.can_reach_project(uuid) to authenticated, service_role;

revoke all on function public.can_access_project(uuid) from public, anon;
grant execute on function public.can_access_project(uuid) to authenticated, service_role;

revoke all on function public.can_access_project_ref(text) from public, anon;
grant execute on function public.can_access_project_ref(text) to authenticated, service_role;

-- 4. Internal-only helper: not reachable from the API at all
revoke all on function public.current_member_organization() from public, anon, authenticated;
grant execute on function public.current_member_organization() to service_role;
