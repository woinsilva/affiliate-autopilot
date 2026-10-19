DROP INDEX IF EXISTS idx_content_one_v1_per_product;
CREATE INDEX IF NOT EXISTS idx_content_product_created ON content_items(product_id, created_at DESC);
