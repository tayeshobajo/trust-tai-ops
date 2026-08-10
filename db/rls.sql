-- Ops Trust Tai RLS foundation
-- Apply after db/schema.sql.
-- This file is the policy contract, not a claim that full security is already live.

alter table organizations enable row level security;
alter table users enable row level security;
alter table projects enable row level security;
alter table project_environments enable row level security;
alter table project_access_methods enable row level security;
alter table project_memory_entries enable row level security;
alter table qa_rules enable row level security;
alter table project_risk_flags enable row level security;
alter table project_recommendations enable row level security;
alter table runs enable row level security;
alter table run_phases enable row level security;
alter table run_findings enable row level security;
alter table run_actions enable row level security;
alter table run_artifacts enable row level security;
alter table run_approvals enable row level security;
alter table qa_reports enable row level security;
alter table qa_results enable row level security;
alter table run_recommendations enable row level security;

create or replace function auth_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function auth_role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', auth.jwt() -> 'user_metadata' ->> 'role', 'viewer')
$$;

create or replace function current_organization_id()
returns uuid
language sql
stable
as $$
  select u.organization_id
  from users u
  where lower(u.email) = auth_email()
  limit 1
$$;

create or replace function can_write_ops()
returns boolean
language sql
stable
as $$
  select auth_role() in ('operator', 'senior_operator', 'admin')
$$;

create or replace function can_approve_ops()
returns boolean
language sql
stable
as $$
  select auth_role() in ('senior_operator', 'admin')
$$;

create policy organizations_select_same_org
on organizations
for select
using (id = current_organization_id());

create policy users_select_same_org
on users
for select
using (organization_id = current_organization_id());

create policy projects_select_same_org
on projects
for select
using (organization_id = current_organization_id());

create policy projects_write_same_org
on projects
for all
using (organization_id = current_organization_id() and can_write_ops())
with check (organization_id = current_organization_id() and can_write_ops());

create policy project_environments_same_org
on project_environments
for all
using (
  exists (
    select 1 from projects p
    where p.id = project_environments.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = project_environments.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy project_access_methods_same_org
on project_access_methods
for all
using (
  exists (
    select 1 from projects p
    where p.id = project_access_methods.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = project_access_methods.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy project_memory_entries_same_org
on project_memory_entries
for all
using (
  exists (
    select 1 from projects p
    where p.id = project_memory_entries.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = project_memory_entries.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy qa_rules_same_org
on qa_rules
for all
using (
  exists (
    select 1 from projects p
    where p.id = qa_rules.project_id
      and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = qa_rules.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy project_risk_flags_same_org
on project_risk_flags
for all
using (
  exists (
    select 1 from projects p
    where p.id = project_risk_flags.project_id
      and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = project_risk_flags.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy project_recommendations_same_org
on project_recommendations
for all
using (
  exists (
    select 1 from projects p
    where p.id = project_recommendations.project_id
      and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = project_recommendations.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy runs_same_org
on runs
for all
using (
  exists (
    select 1 from projects p
    where p.id = runs.project_id
      and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1 from projects p
    where p.id = runs.project_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy run_children_same_org_select
on run_phases
for select
using (
  exists (
    select 1
    from runs r
    join projects p on p.id = r.project_id
    where r.id = run_phases.run_id
      and p.organization_id = current_organization_id()
  )
);

create policy run_children_same_org_write
on run_phases
for all
using (
  exists (
    select 1
    from runs r
    join projects p on p.id = r.project_id
    where r.id = run_phases.run_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
)
with check (
  exists (
    select 1
    from runs r
    join projects p on p.id = r.project_id
    where r.id = run_phases.run_id
      and p.organization_id = current_organization_id()
      and can_write_ops()
  )
);

create policy run_findings_same_org_select
on run_findings
for select
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_findings.run_id and p.organization_id = current_organization_id()
  )
);

create policy run_findings_same_org_write
on run_findings
for all
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_findings.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
)
with check (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_findings.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
);

create policy run_actions_same_org_select
on run_actions
for select
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_actions.run_id and p.organization_id = current_organization_id()
  )
);

create policy run_actions_same_org_write
on run_actions
for all
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_actions.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
)
with check (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_actions.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
);

create policy run_artifacts_same_org_select
on run_artifacts
for select
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_artifacts.run_id and p.organization_id = current_organization_id()
  )
);

create policy run_artifacts_same_org_write
on run_artifacts
for all
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_artifacts.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
)
with check (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_artifacts.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
);

create policy run_approvals_same_org_select
on run_approvals
for select
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_approvals.run_id and p.organization_id = current_organization_id()
  )
);

create policy run_approvals_same_org_write
on run_approvals
for all
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_approvals.run_id and p.organization_id = current_organization_id() and can_approve_ops()
  )
)
with check (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_approvals.run_id and p.organization_id = current_organization_id() and can_approve_ops()
  )
);

create policy qa_reports_same_org
on qa_reports
for all
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = qa_reports.run_id and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = qa_reports.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
);

create policy qa_results_same_org
on qa_results
for all
using (
  exists (
    select 1
    from qa_reports qr
    join runs r on r.id = qr.run_id
    join projects p on p.id = r.project_id
    where qr.id = qa_results.qa_report_id and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1
    from qa_reports qr
    join runs r on r.id = qr.run_id
    join projects p on p.id = r.project_id
    where qr.id = qa_results.qa_report_id and p.organization_id = current_organization_id() and can_write_ops()
  )
);

create policy run_recommendations_same_org
on run_recommendations
for all
using (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_recommendations.run_id and p.organization_id = current_organization_id()
  )
)
with check (
  exists (
    select 1 from runs r join projects p on p.id = r.project_id
    where r.id = run_recommendations.run_id and p.organization_id = current_organization_id() and can_write_ops()
  )
);
