with keep as (
  select distinct on (name, primary_domain) id
  from public.projects
  order by name, primary_domain, created_at asc
)
delete from public.projects where id not in (select id from keep);