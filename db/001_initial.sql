CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id),
  provider text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  affiliate_url text NOT NULL,
  image_url text,
  price numeric(12,2),
  currency char(3) NOT NULL DEFAULT 'BRL',
  score numeric(6,3) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'selected' CHECK (status IN ('discovered','selected','rejected','archived')),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, provider, external_id)
);

CREATE TABLE IF NOT EXISTS content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id),
  product_id uuid NOT NULL REFERENCES products(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scripted','generating','video_ready','qa_passed','qa_failed','scheduled','published','failed','generation_uncertain')),
  hook text,
  script text,
  caption text,
  call_to_action text,
  video_url text,
  qa_score numeric(5,2),
  qa_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_one_v1_per_product ON content_items(product_id);

CREATE TABLE IF NOT EXISTS publication_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id),
  content_id uuid NOT NULL REFERENCES content_items(id),
  platform text NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','publishing','published','failed','uncertain')),
  external_id text,
  external_url text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(content_id, platform)
);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id),
  publication_id uuid NOT NULL REFERENCES publication_jobs(id),
  views integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  comments integer NOT NULL DEFAULT 0,
  shares integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  revenue numeric(12,2) NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT now()
);

-- One row per billable or externally visible operation. Unique keys prevent retries
-- from generating another paid video or duplicate social post after a restart.
CREATE TABLE IF NOT EXISTS operation_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id),
  operation_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('reserved','succeeded','failed','uncertain')),
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb,
  external_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid REFERENCES brands(id),
  kind text NOT NULL,
  recipient text,
  status text NOT NULL,
  subject text NOT NULL,
  provider_id text,
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_events (
  id bigserial PRIMARY KEY,
  brand_id uuid REFERENCES brands(id),
  level text NOT NULL CHECK (level IN ('info','warning','critical')),
  source text NOT NULL,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_status ON content_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_publications_status ON publication_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_publication ON analytics_snapshots(publication_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_unresolved ON system_events(level, created_at DESC) WHERE resolved_at IS NULL;

INSERT INTO brands (slug, name, timezone, settings)
VALUES ('achadinhos', 'Achadinhos', 'America/Sao_Paulo', '{"primaryMarketplace":"mercado-livre","enabledPlatforms":["instagram"]}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
