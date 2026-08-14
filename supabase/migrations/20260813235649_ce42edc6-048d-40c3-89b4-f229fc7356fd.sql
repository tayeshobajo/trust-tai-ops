create table if not exists public.run_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid not null unique references public.runs(id) on delete cascade,
  goal text not null default '',
  hypotheses jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists run_plans_project_idx on public.run_plans (project_id);

grant select, insert, update on public.run_plans to authenticated;
grant all on public.run_plans to service_role;

alter table public.run_plans enable row level security;

drop policy if exists run_plans_select on public.run_plans;
create policy run_plans_select on public.run_plans
  for select to authenticated
  using (private.can_reach_project(project_id));

drop policy if exists run_plans_insert on public.run_plans;
create policy run_plans_insert on public.run_plans
  for insert to authenticated
  with check (private.can_reach_project(project_id));

drop policy if exists run_plans_update on public.run_plans;
create policy run_plans_update on public.run_plans
  for update to authenticated
  using (private.can_reach_project(project_id))
  with check (private.can_reach_project(project_id));

create or replace function public.run_plans_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists run_plans_touch_trigger on public.run_plans;
create trigger run_plans_touch_trigger
  before update on public.run_plans
  for each row execute function public.run_plans_touch();