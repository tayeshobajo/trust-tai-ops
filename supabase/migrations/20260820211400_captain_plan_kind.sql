-- Extend project_messages kind check to include fix_plan and captain_plan.
-- The original constraint only covered the four base kinds; structured agent
-- messages (fix_plan, captain_plan) were silently rejected on insert.

ALTER TABLE public.project_messages
  DROP CONSTRAINT IF EXISTS project_messages_kind_check;

ALTER TABLE public.project_messages
  ADD CONSTRAINT project_messages_kind_check
  CHECK (kind = ANY (ARRAY[
    'message'::text,
    'status_update'::text,
    'decision_request'::text,
    'decision_response'::text,
    'fix_plan'::text,
    'captain_plan'::text
  ]));
