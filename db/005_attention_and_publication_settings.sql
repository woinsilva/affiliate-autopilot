ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

ALTER TABLE publication_jobs
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_content_attention
  ON content_items(product_id, created_at DESC)
  WHERE dismissed_at IS NULL;
