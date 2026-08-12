-- Evidence intake release closure. Safe to apply twice.

alter table public.project_evidence add column if not exists intake_key text;

-- A retry of the same queued file converges on one reservation.
create unique index if not exists project_evidence_intake_key_idx
  on public.project_evidence (project_id, intake_key)
  where intake_key is not null;

-- Abandoned reservations are pruned on a bounded TTL.
create index if not exists project_evidence_stale_uploads_idx
  on public.project_evidence (project_id, status, created_at);