-- Phase 3: Captain Outcome Store
-- Structured result record for every Captain job completion.
-- Captain writes here via captain-write-back edge function.
-- Daemon also writes here on execution_summary set.
-- Frontend reads here for Outcome History panel.

create table if not exists public.captain_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects(id) on delete cascade,
  request_id          uuid references public.captain_plan_requests(id) on delete set null,

  -- What type of job this was
  job_type            text not null, -- ssl_install | ssl_renew | wp_plugin_install | wp_debug_fix | deploy_static | etc.

  -- Target entity (domain, plugin slug, repo, etc.)
  target              text not null, -- e.g. lesterestatewines.com

  -- Outcome
  verdict             text not null check (verdict in ('pass', 'fail', 'partial')),
  summary             text not null,           -- plain-English what happened
  evidence            text,                    -- raw verification output

  -- Structured metadata — job-type-specific fields
  -- ssl: cert_expiry, cert_issuer, domains_covered
  -- wp: plugin_slug, plugin_version, before_state, after_state
  -- deploy: commit_sha, deploy_url
  outcome_data        jsonb not null default '{}'::jsonb,

  -- Follow-up trigger (optional)
  -- If set, a cron/monitor should fire a new job at this time
  next_action_type    text,           -- e.g. ssl_renew
  next_action_due_at  timestamptz,    -- e.g. 2026-10-16 for cert renewal

  -- Session link
  captain_session_ref text,           -- OpenClaw session key or run ID for audit trail

  -- Who / when
  completed_by        text not null default 'captain',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes for common access patterns
create index idx_captain_outcomes_project    on public.captain_outcomes(project_id, created_at desc);
create index idx_captain_outcomes_job_type   on public.captain_outcomes(job_type);
create index idx_captain_outcomes_target     on public.captain_outcomes(target);
create index idx_captain_outcomes_next_action on public.captain_outcomes(next_action_due_at)
  where next_action_due_at is not null;
create index idx_captain_outcomes_request    on public.captain_outcomes(request_id)
  where request_id is not null;

-- RLS: service role full access; authenticated org members can read their project outcomes
alter table public.captain_outcomes enable row level security;

create policy "Service role full access on captain_outcomes"
  on public.captain_outcomes
  for all
  to service_role
  using (true)
  with check (true);

create policy "Org members can read their project outcomes"
  on public.captain_outcomes
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      join public.users u on u.organization_id = p.organization_id
      where u.auth_user_id = auth.uid()
    )
  );

-- Updated_at trigger
create or replace function public.set_captain_outcomes_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tg_captain_outcomes_updated_at
  before update on public.captain_outcomes
  for each row execute function public.set_captain_outcomes_updated_at();
