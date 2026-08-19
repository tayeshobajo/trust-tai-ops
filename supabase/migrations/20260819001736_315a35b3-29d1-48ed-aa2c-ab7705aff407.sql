alter table public.organizations
  add column if not exists trust_tai_os_organization_id uuid,
  add column if not exists ops_auto_provision boolean not null default true,
  add column if not exists ops_auto_provision_role text not null default 'viewer';

create unique index if not exists organizations_trust_tai_os_org_idx
  on public.organizations (trust_tai_os_organization_id)
  where trust_tai_os_organization_id is not null;

alter table public.users
  add column if not exists provisioned_via text not null default 'manual';