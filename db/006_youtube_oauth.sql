ALTER TABLE oauth_sessions DROP CONSTRAINT IF EXISTS oauth_sessions_platform_check;
ALTER TABLE oauth_sessions ADD CONSTRAINT oauth_sessions_platform_check CHECK (platform IN ('tiktok','youtube'));

ALTER TABLE social_connections DROP CONSTRAINT IF EXISTS social_connections_platform_check;
ALTER TABLE social_connections ADD CONSTRAINT social_connections_platform_check CHECK (platform IN ('tiktok','youtube'));
