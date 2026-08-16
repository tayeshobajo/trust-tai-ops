-- knowledge_base_entries: server-only by design (written/read by edge functions)
revoke all on public.knowledge_base_entries from anon;
revoke all on public.knowledge_base_entries from authenticated;
grant all on public.knowledge_base_entries to service_role;
alter table public.knowledge_base_entries enable row level security;

drop policy if exists knowledge_base_entries_service_only on public.knowledge_base_entries;
create policy knowledge_base_entries_service_only
  on public.knowledge_base_entries
  for all
  to service_role
  using (true)
  with check (true);

-- project_access_secrets: encrypted credentials, service role only (explicit)
revoke all on public.project_access_secrets from anon;
revoke all on public.project_access_secrets from authenticated;
grant all on public.project_access_secrets to service_role;

-- agent_execution_events: members read their org's history, writes stay service-role only
revoke all on public.agent_execution_events from anon;
revoke insert, update, delete on public.agent_execution_events from authenticated;
grant select on public.agent_execution_events to authenticated;
grant all on public.agent_execution_events to service_role;