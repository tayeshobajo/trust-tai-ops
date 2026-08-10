-- Trust Tai Ops — SSH access storage, host pinning, and WP-CLI audit trail.
-- Idempotent: safe to run against an existing database more than once.
--
-- Three things happen here:
--   1. The server-only secret store gains non-secret connection details and a
--      pinned SSH host identity. No plaintext credential column is added.
--   2. The pin can only be written by the service role, so a client can never
--      teach the system to trust a different server.
--   3. The verification guard is extended to SSH, so "verified" continues to
--      mean a real server-side check actually succeeded.

-- ---------------------------------------------------------------------------
-- 1. Non-secret connection details + pinned host identity.
-- ---------------------------------------------------------------------------

alter table public.project_access_secrets
  add column if not exists config jsonb not null default '{}'::jsonb;

alter table public.project_access_secrets
  add column if not exists host_fingerprint text;

-- Only an OpenSSH SHA256 fingerprint may ever be recorded as a pin.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.project_access_secrets'::regclass
      and conname = 'project_access_secrets_host_fingerprint_shape'
  ) then
    alter table public.project_access_secrets
      add constraint project_access_secrets_host_fingerprint_shape
      check (host_fingerprint is null or host_fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$');
  end if;
end $$;

comment on column public.project_access_secrets.config is
  'Non-secret connection details only (host, port, wpRoot, wpBinary). Never a credential.';
comment on column public.project_access_secrets.host_fingerprint is
  'Pinned SSH host identity. Written only by the server after a successful connection.';

-- The table already grants nothing to anon or authenticated; these columns
-- inherit that. Restated so a future grant cannot silently widen access.
revoke all on public.project_access_secrets from anon;
revoke all on public.project_access_secrets from authenticated;
grant all on public.project_access_secrets to service_role;

-- ---------------------------------------------------------------------------
-- 2. "Verified" for SSH must also come from a real server-side check.
-- ---------------------------------------------------------------------------

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
  if new.access_type not in ('wordpress_admin', 'ssh') then
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