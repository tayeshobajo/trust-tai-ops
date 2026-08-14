-- 1. project_messages: single consistent membership helper
drop policy if exists project_messages_same_org on public.project_messages;
drop policy if exists project_messages_member_read on public.project_messages;
drop policy if exists project_messages_member_append on public.project_messages;
drop policy if exists project_messages_member_write on public.project_messages;

create policy project_messages_member_read
on public.project_messages for select to authenticated
using (private.can_reach_project(project_id));

create policy project_messages_member_append
on public.project_messages for insert to authenticated
with check (private.can_write_project(project_id));

-- 2. project_evidence: explicit, membership-scoped writes
drop policy if exists project_evidence_member_insert on public.project_evidence;
drop policy if exists project_evidence_member_update on public.project_evidence;
drop policy if exists project_evidence_member_delete on public.project_evidence;

create policy project_evidence_member_insert
on public.project_evidence for insert to authenticated
with check (private.can_write_project(project_id));

create policy project_evidence_member_update
on public.project_evidence for update to authenticated
using (private.can_write_project(project_id))
with check (private.can_write_project(project_id));

create policy project_evidence_member_delete
on public.project_evidence for delete to authenticated
using (private.can_write_project(project_id));

grant select, insert, update, delete on public.project_evidence to authenticated;
grant all on public.project_evidence to service_role;

-- 3. storage.objects: scope the private evidence bucket to project membership
create or replace function private.evidence_object_project(_name text)
returns uuid
language sql
immutable
as $$
  select case
    when split_part(_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then split_part(_name, '/', 1)::uuid
    else null
  end
$$;

drop policy if exists project_evidence_objects_read on storage.objects;
drop policy if exists project_evidence_objects_insert on storage.objects;
drop policy if exists project_evidence_objects_update on storage.objects;
drop policy if exists project_evidence_objects_delete on storage.objects;

create policy project_evidence_objects_read
on storage.objects for select to authenticated
using (
  bucket_id = 'project-evidence'
  and private.can_reach_project(private.evidence_object_project(name))
);

create policy project_evidence_objects_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'project-evidence'
  and private.can_write_project(private.evidence_object_project(name))
);

create policy project_evidence_objects_update
on storage.objects for update to authenticated
using (
  bucket_id = 'project-evidence'
  and private.can_write_project(private.evidence_object_project(name))
)
with check (
  bucket_id = 'project-evidence'
  and private.can_write_project(private.evidence_object_project(name))
);

create policy project_evidence_objects_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'project-evidence'
  and private.can_write_project(private.evidence_object_project(name))
);