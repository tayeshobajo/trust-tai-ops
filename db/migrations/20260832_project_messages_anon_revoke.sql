-- Defense in depth for public.project_messages.
--
-- RLS already scopes every row to the caller's organization, but the anon role
-- had table privileges that only RLS stood behind. Conversation history is
-- tenant data: an unauthenticated browser has no legitimate reason to hold any
-- privilege on it at all. Authenticated keeps exactly the privileges the
-- existing policies rely on (read the org's history, append to it).
--
-- Idempotent: revoke/grant are declarative and safe to run repeatedly.

do $$
begin
  if to_regclass('public.project_messages') is null then
    return;
  end if;

  revoke all on public.project_messages from anon;
  revoke all on public.project_messages from public;

  grant select, insert on public.project_messages to authenticated;
  grant all on public.project_messages to service_role;
end
$$;
