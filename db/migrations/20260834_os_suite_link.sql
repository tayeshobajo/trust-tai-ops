-- Trust Tai OS <-> Ops suite integration v1.
--
-- Ops stays the owner of technical operational state. Trust Tai OS owns the
-- canonical business project and the canonical person. This migration adds
-- only the two link columns needed to join them, nothing more. It is
-- idempotent and safe to re-run.

-- 1. Canonical business project link on the Ops technical project.
alter table projects
  add column if not exists trust_tai_os_project_id uuid;

-- A canonical OS project maps to at most one Ops project per organization.
-- Partial, so the (very common) unlinked Ops project is unaffected.
create unique index if not exists projects_trust_tai_os_project_idx
  on projects (organization_id, trust_tai_os_project_id)
  where trust_tai_os_project_id is not null;

-- 2. External identity reference for the OS person. Exact, never fuzzy.
alter table users
  add column if not exists trust_tai_os_user_id uuid;

create unique index if not exists users_trust_tai_os_user_idx
  on users (trust_tai_os_user_id)
  where trust_tai_os_user_id is not null;

-- users.auth_user_id already exists on current deployments; guarded here so an
-- older database can still run this file end to end.
alter table users
  add column if not exists auth_user_id uuid;

create unique index if not exists users_auth_user_idx
  on users (auth_user_id)
  where auth_user_id is not null;