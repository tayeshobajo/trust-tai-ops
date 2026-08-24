drop policy if exists qa_reports_same_org on public.qa_reports;

create policy qa_reports_select_same_org on public.qa_reports for select to authenticated
using (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = qa_reports.run_id and p.organization_id = private.current_organization_id()));

create policy qa_reports_insert_same_org on public.qa_reports for insert to authenticated
with check (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = qa_reports.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()));

create policy qa_reports_update_same_org on public.qa_reports for update to authenticated
using (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = qa_reports.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()))
with check (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = qa_reports.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()));

create policy qa_reports_delete_same_org on public.qa_reports for delete to authenticated
using (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = qa_reports.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()));

drop policy if exists run_recommendations_same_org on public.run_recommendations;

create policy run_recommendations_select_same_org on public.run_recommendations for select to authenticated
using (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = run_recommendations.run_id and p.organization_id = private.current_organization_id()));

create policy run_recommendations_insert_same_org on public.run_recommendations for insert to authenticated
with check (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = run_recommendations.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()));

create policy run_recommendations_update_same_org on public.run_recommendations for update to authenticated
using (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = run_recommendations.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()))
with check (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = run_recommendations.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()));

create policy run_recommendations_delete_same_org on public.run_recommendations for delete to authenticated
using (exists (select 1 from public.runs r join public.projects p on p.id = r.project_id
  where r.id = run_recommendations.run_id and p.organization_id = private.current_organization_id() and public.can_write_ops()));