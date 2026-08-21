alter table public.runs add column if not exists queue_position integer;
comment on column public.runs.queue_position is 'When set, the task is waiting in the project queue and the agent must not work on it. Null means it is a normal (active or finished) task.';
create index if not exists runs_queue_position_idx on public.runs (project_id, queue_position) where queue_position is not null;