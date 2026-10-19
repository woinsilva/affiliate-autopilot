ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'ai_video'
    CHECK (media_kind IN ('ai_video','slideshow'));

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS image_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
