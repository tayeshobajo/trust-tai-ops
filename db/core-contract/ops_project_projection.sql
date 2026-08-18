-- ============================================================================
-- Trust Tai CORE (okydosoacqdnursmmenf) — Ops project read projection
-- ----------------------------------------------------------------------------
-- APPLY THIS IN THE CORE SUPABASE PROJECT, NOT IN OPS.
--
-- Ops (tdqeizrgdasztvbvwanp) remains the canonical owner of Ops projects.
-- This table is a synchronized, org-scoped READ projection so cmd.trusttai.com
-- can list real Ops projects and deep link into them, without creating a
-- competing editable copy. Core never writes it; Ops upserts it with the
-- signed-in Core user's own token, so Core RLS stays the boundary.
--
-- Deterministic key: (organization_id, ops_project_id).
-- Unknown metrics are NULL. Never render NULL as 0.
-- ============================================================================

create table if not exists public.ops_project_projection (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  app_key text not null default 'ops',
  ops_project_id uuid not null,
  canonical_project_id uuid,
  client_label text not null default '',
  project_name text not null default '',
  primary_domain text,
  status text not null default 'active',
  lifecycle_state text not null default 'active',   -- active | archived | removed
  health text,                                      -- stable | watching | at_risk | null
  needs_attention boolean not null default false,
  owner text,
  open_issues integer,                              -- NULL = unknown
  open_approvals integer,                           -- NULL = unknown
  open_recommendations integer,                     -- NULL = unknown
  open_risks integer,                               -- NULL = unknown
  last_activity_at timestamptz,
  ops_path text not null,                           -- e.g. /projects/<uuid>
  ops_url text not null,                            -- e.g. https://ops.trusttai.com/projects/<uuid>
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, ops_project_id)
);

create index if not exists ops_project_projection_org_idx
  on public.ops_project_projection (organization_id, lifecycle_state, needs_attention);

-- Data API access. Members read; members of the same organization upsert
-- (the writer is Ops acting as the signed-in Core user).
grant select, insert, update on public.ops_project_projection to authenticated;
grant all on public.ops_project_projection to service_role;

alter table public.ops_project_projection enable row level security;

-- Replace `public.is_org_member(uuid)` with Core's existing membership helper
-- if it is named differently. Cross-organization access must stay impossible.
create policy "org members read ops projection"
  on public.ops_project_projection
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy "org members upsert ops projection"
  on public.ops_project_projection
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "org members refresh ops projection"
  on public.ops_project_projection
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- No delete policy on purpose: Ops marks lifecycle_state = 'removed' instead
-- of deleting, so Core shows the honest end state rather than a silent gap.