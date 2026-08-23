-- Phase 5 Completion: Client Contact Cadence — durable event source.
--
-- The monitor needs a real, durable record of human→client contact to detect
-- cadence gaps honestly. No invented data: a project with zero contact events
-- reports "no contact logged" rather than a fake date.
--
-- Idempotent: safe to apply more than once.

begin;

-- 1. Table ----------------------------------------------------------------------
create table if not exists public.project_contact_events (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,

  -- When the contact happened (not when it was logged — can be backdated)
  contacted_at timestamptz not null default now(),
  channel      text not null check (channel in ('email', 'phone', 'sms', 'meeting', 'slack', 'other')),
  direction    text not null check (direction in ('outbound', 'inbound')),

  summary      text not null,

  -- The authenticated human who logged it. Set server-side where possible;
  -- client insert path fills from auth.uid() via default.
  recorded_by  uuid references auth.users(id) on delete set null,
  recorded_by_email text,

  created_at   timestamptz not null default now()
);

create index if not exists idx_project_contact_events_project
  on public.project_contact_events(project_id, contacted_at desc);

-- 2. RLS -------------------------------------------------------------------------
alter table public.project_contact_events enable row level security;

create policy "Service role full access on project_contact_events"
  on public.project_contact_events for all
  to service_role using (true) with check (true);

create policy "Org members can read their project contact events"
  on public.project_contact_events for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      join public.users u on u.organization_id = p.organization_id
      where u.auth_user_id = auth.uid()
    )
  );

create policy "Org members can write their project contact events"
  on public.project_contact_events for insert
  to authenticated
  with check (
    project_id in (
      select p.id from public.projects p
      join public.users u on u.organization_id = p.organization_id
      where u.auth_user_id = auth.uid()
    )
  );

grant select, insert on public.project_contact_events to authenticated;
grant all on public.project_contact_events to service_role;

comment on table public.project_contact_events is
  'Durable log of human→client contact per project. Source of truth for the Phase 5 client-cadence monitor check.';

commit;
