-- Conversation history: no anon privileges, and append-only for people.
--
-- RLS already scoped every row to the caller's organization, but anon still
-- held table privileges with only RLS behind them, and authenticated could
-- update or delete rows. Conversation history is the record of what the human
-- asked and approved; the agent and the audit trail both read it back. It must
-- not be rewritable from a browser.
--
-- Idempotent: privileges are declarative, policies are dropped before create.

do $$
begin
  if to_regclass('public.project_messages') is null then
    return;
  end if;

  revoke all on public.project_messages from anon;
  revoke all on public.project_messages from public;
  revoke update, delete, truncate, references, trigger on public.project_messages from authenticated;

  grant select, insert on public.project_messages to authenticated;
  grant all on public.project_messages to service_role;
end
$$;

drop policy if exists project_messages_same_org on public.project_messages;
drop policy if exists project_messages_member_read on public.project_messages;
drop policy if exists project_messages_member_append on public.project_messages;

create policy project_messages_member_read
on public.project_messages
for select
to authenticated
using (private.can_access_project(project_id));

create policy project_messages_member_append
on public.project_messages
for insert
to authenticated
with check (private.can_write_project(project_id));
