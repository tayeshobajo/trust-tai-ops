alter table public.project_memory_entries
  drop constraint if exists project_memory_entries_memory_type_check;

alter table public.project_memory_entries
  add constraint project_memory_entries_memory_type_check
  check (memory_type = any (array['stack_note','incident_note','risk_note','qa_rule','procedure','constraint']));

alter table public.memory_candidates
  drop constraint if exists memory_candidates_memory_type_check;

alter table public.memory_candidates
  add constraint memory_candidates_memory_type_check
  check (memory_type = any (array['stack_note','incident_note','risk_note','qa_rule','procedure','constraint']));