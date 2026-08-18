drop policy if exists run_plans_insert on public.run_plans;
drop policy if exists run_plans_select on public.run_plans;
drop policy if exists run_plans_update on public.run_plans;
revoke delete on public.run_plans from authenticated;
revoke insert, update, delete, select on public.project_events from anon;
grant select on public.project_events to authenticated;
grant all on public.project_events to service_role;