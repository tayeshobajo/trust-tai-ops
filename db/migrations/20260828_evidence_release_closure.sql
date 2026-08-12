-- Evidence intake release closure.
--
-- Retrying an upload must converge on one record, and a reservation nobody
-- ever uploaded to must be findable so it can be pruned.
--
-- Safe to apply twice: every statement is guarded.

begin;

alter table public.project_evidence add column if not exists intake_key text;

-- A retry of the same queued file (double submit, network retry) converges on
-- the reservation it already made instead of making a second one. Scoped by
-- message inside the key itself, so re-using a file on a *different* message
-- is still a new record.
create unique index if not exists project_evidence_intake_key_idx
  on public.project_evidence (project_id, intake_key)
  where intake_key is not null;

-- Abandoned `uploading` rows are pruned on a bounded TTL when intake runs.
create index if not exists project_evidence_stale_uploads_idx
  on public.project_evidence (project_id, status, created_at);

commit;

-- Defence in depth, applied outside SQL because Supabase owns `storage.buckets`:
-- the `project-evidence` bucket stays private, with a 25 MB object ceiling and
-- an allowed-MIME list matching `_shared/evidencePolicy.ts`. Commit-time byte
-- validation in `_shared/evidenceBytes.ts` remains the authoritative gate.
