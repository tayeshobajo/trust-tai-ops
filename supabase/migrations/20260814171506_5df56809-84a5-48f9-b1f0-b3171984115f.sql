create or replace function private.evidence_object_project(_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then split_part(_name, '/', 1)::uuid
    else null
  end
$$;