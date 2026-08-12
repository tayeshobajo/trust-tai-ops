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