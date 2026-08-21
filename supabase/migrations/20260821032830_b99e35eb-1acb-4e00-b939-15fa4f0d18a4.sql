
ALTER TABLE public.run_artifacts DROP CONSTRAINT IF EXISTS run_artifacts_artifact_type_check;
ALTER TABLE public.run_artifacts ADD CONSTRAINT run_artifacts_artifact_type_check
  CHECK (artifact_type = ANY (ARRAY['backup_note'::text,'scan_result'::text,'diff_summary'::text,'qa_capture'::text,'report'::text,'fix_plan'::text,'execution_failed'::text]));
