-- Trust Tai Ops — verification integrity + tenant identity hardening.
-- Idempotent: safe to run against an existing database more than once.
--
-- Two things happen here:
--   1. `users.auth_user_id` gives tenant identity a real key. Membership now
--      resolves by Supabase auth UID first and falls back to email only for
--      rows that predate the column.
--   2. A database-level guard so "verified" cannot be forged. Only a real
--      server-side credential check writes `last_verified_at`.

-- ---------------------------------------------------------------------------
-- 1. Tenant identity: auth UID first, email as a transitional fallback.
-- ---------------------------------------------------------------------------

alter table public.users add column if not exists auth_user_id uuid;

create unique index if not exists users_auth_user_id_key
  on public.users (auth_user_id)
  where auth_user_id is not null;

create or replace function public.current_member_organization()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from (
    -- Preferred: the row is bound to this auth identity by key.
    select u.organization_id, 0 as precedence
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.status <> 'disabled'
    union all
    -- Transitional: rows created before `auth_user_id` existed. Remove this
    -- branch once every active user row has been backfilled.
    select u.organization_id, 1 as precedence
    from public.users u
    join auth.users au on lower(au.email) = lower(u.email)
    where au.id = auth.uid()
      and u.auth_user_id is null
      and u.status <> 'disabled'
  ) resolved
  order by precedence
  limit 1
$$;

revoke all on function public.current_member_organization() from public, anon;
grant execute on function public.current_member_organization() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. `last_verified_at` may only reflect a real server-side check.
-- ---------------------------------------------------------------------------
--
-- The browser holds write access to `project_access_methods` so a person can
-- record where access lives. That must not extend to claiming a credential was
-- accepted. For access types with an executable credential path, a verified
-- timestamp is only allowed when the server-only secret store agrees.

create or replace function public.guard_access_method_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  proposed timestamptz := new.last_verified_at;
  previous timestamptz := case when tg_op = 'UPDATE' then old.last_verified_at else null end;
begin
  -- The service role is the server-side verifier itself.
  if current_setting('role', true) = 'service_role' or session_user = 'service_role' then
    return new;
  end if;

  if proposed is null or proposed is not distinct from previous then
    return new;
  end if;

  -- Only executable credential types are guarded. Everything else is a
  -- human-maintained note and is not claimed to be machine-verified.
  if new.access_type <> 'wordpress_admin' then
    return new;
  end if;

  if not exists (
    select 1
    from public.project_access_secrets s
    where s.project_id = new.project_id
      and s.access_type = new.access_type
      and s.verification_state = 'verified'
      and s.last_verified_at is not distinct from proposed
  ) then
    -- Refuse the forged stamp without failing the rest of the write.
    new.last_verified_at := previous;
  end if;

  return new;
end $$;

revoke all on function public.guard_access_method_verification() from public, anon, authenticated;

drop trigger if exists project_access_methods_verification_guard on public.project_access_methods;
create trigger project_access_methods_verification_guard
  before insert or update on public.project_access_methods
  for each row execute function public.guard_access_method_verification();
