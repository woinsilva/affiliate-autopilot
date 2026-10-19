ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_status_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_status_check CHECK (
  status IN ('draft','scripted','generating','video_ready','qa_passed','qa_failed','awaiting_approval','scheduled','published','failed','generation_uncertain')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_unique_affiliate_url
  ON products(brand_id, affiliate_url);
