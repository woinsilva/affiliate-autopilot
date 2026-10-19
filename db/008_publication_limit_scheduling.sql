ALTER TABLE publication_jobs DROP CONSTRAINT IF EXISTS publication_jobs_status_check;
ALTER TABLE publication_jobs ADD CONSTRAINT publication_jobs_status_check
  CHECK (status IN ('pending','publishing','scheduled','published','failed','uncertain'));

ALTER TABLE publication_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS limit_kind text;

CREATE INDEX IF NOT EXISTS idx_publications_scheduled
  ON publication_jobs(next_attempt_at)
  WHERE status='scheduled';
