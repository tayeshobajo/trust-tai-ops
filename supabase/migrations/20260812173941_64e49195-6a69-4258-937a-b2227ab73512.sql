-- Continuity hardening: server-owned writes + indexes for named recall.
revoke all on public.conversation_anchors from anon;
revoke all on public.conversation_anchors from authenticated;
grant select on public.conversation_anchors to authenticated;
grant all on public.conversation_anchors to service_role;

revoke all on public.message_references from anon;
revoke all on public.message_references from authenticated;
grant select on public.message_references to authenticated;
grant all on public.message_references to service_role;

-- A months-old "Option B" is found by name, not by being recent.
create index if not exists conversation_anchors_label_idx
  on public.conversation_anchors (project_id, normalized_label);
create index if not exists conversation_anchors_aliases_idx
  on public.conversation_anchors using gin (aliases);
-- Bounds the one-off legacy backfill scan over historical agent messages.
create index if not exists project_messages_role_recent_idx
  on public.project_messages (project_id, role, created_at desc);