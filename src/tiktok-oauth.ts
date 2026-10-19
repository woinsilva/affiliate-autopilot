import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

const requiredScopes = ['user.info.basic', 'video.publish'];
const tokenUrl = 'https://open.tiktokapis.com/v2/oauth/token/';

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  log_id?: string;
};

type ConnectionRow = {
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
};

function ensureOAuthConfigured(): void {
  if (!config.TIKTOK_CLIENT_KEY || !config.TIKTOK_CLIENT_SECRET) {
    throw new Error('Informe TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET no arquivo .env');
  }
}

function encryptionKey(): Buffer {
  ensureOAuthConfigured();
  return createHash('sha256').update(`affiliate-autopilot:tiktok:${config.TIKTOK_CLIENT_SECRET}`).digest();
}

export function encryptTikTokToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptTikTokToken(value: string): string {
  const [ivEncoded, tagEncoded, encryptedEncoded] = value.split('.');
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) throw new Error('Token TikTok armazenado em formato inválido');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedEncoded, 'base64url')), decipher.final()]).toString('utf8');
}

async function exchangeToken(parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as TokenResponse;
  if (!response.ok || result.error || !result.access_token || !result.refresh_token || !result.open_id) {
    throw new Error(`TikTok OAuth falhou: ${result.error_description ?? result.error ?? response.status}${result.log_id ? ` (${result.log_id})` : ''}`);
  }
  return result;
}

async function fetchProfile(accessToken: string): Promise<{ displayName?: string; avatarUrl?: string }> {
  try {
    const response = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { data?: { user?: { display_name?: string; avatar_url?: string } } };
    if (!response.ok) return {};
    return { displayName: result.data?.user?.display_name, avatarUrl: result.data?.user?.avatar_url };
  } catch {
    return {};
  }
}

export async function createTikTokAuthorization(brandId: string): Promise<string> {
  ensureOAuthConfigured();
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('hex');
  await db.query('DELETE FROM oauth_sessions WHERE expires_at < now()');
  await db.query(
    `INSERT INTO oauth_sessions (state,brand_id,platform,code_verifier,expires_at)
     VALUES ($1,$2,'tiktok',$3,now() + interval '10 minutes')`,
    [state, brandId, codeVerifier],
  );
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.search = new URLSearchParams({
    client_key: config.TIKTOK_CLIENT_KEY,
    scope: requiredScopes.join(','),
    response_type: 'code',
    redirect_uri: config.TIKTOK_REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    disable_auto_auth: '1',
  }).toString();
  return url.toString();
}

export async function completeTikTokAuthorization(input: { state: string; code: string }): Promise<{ brandId: string; username: string | null }> {
  ensureOAuthConfigured();
  const session = await db.query<{ brand_id: string; code_verifier: string; expires_at: Date }>(
    `DELETE FROM oauth_sessions WHERE state=$1 AND platform='tiktok' RETURNING brand_id,code_verifier,expires_at`,
    [input.state],
  );
  const stored = session.rows[0];
  if (!stored) throw new Error('A autorização expirou ou não pertence a esta sessão. Tente conectar novamente.');
  if (stored.expires_at.getTime() <= Date.now()) throw new Error('A autorização expirou. Tente conectar novamente.');
  const token = await exchangeToken({
    client_key: config.TIKTOK_CLIENT_KEY,
    client_secret: config.TIKTOK_CLIENT_SECRET,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: config.TIKTOK_REDIRECT_URI,
    code_verifier: stored.code_verifier,
  });
  const scopes = (token.scope ?? '').split(',').map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.includes('video.publish')) throw new Error('A conta não autorizou a permissão necessária para publicar vídeos.');
  const profile = await fetchProfile(token.access_token!);
  const expiresAt = new Date(Date.now() + Number(token.expires_in ?? 86_400) * 1_000);
  const refreshExpiresAt = new Date(Date.now() + Number(token.refresh_expires_in ?? 31_536_000) * 1_000);
  await db.query(
    `INSERT INTO social_connections
       (brand_id,platform,account_id,account_username,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,refresh_token_expires_at,scopes,metadata,status)
     VALUES ($1,'tiktok',$2,$3,$4,$5,$6,$7,$8,$9,'connected')
     ON CONFLICT (brand_id,platform) DO UPDATE SET
       account_id=excluded.account_id,account_username=excluded.account_username,
       access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,
       access_token_expires_at=excluded.access_token_expires_at,refresh_token_expires_at=excluded.refresh_token_expires_at,
       scopes=excluded.scopes,metadata=excluded.metadata,status='connected',updated_at=now()`,
    [stored.brand_id, token.open_id, profile.displayName ?? null, encryptTikTokToken(token.access_token!), encryptTikTokToken(token.refresh_token!), expiresAt, refreshExpiresAt, scopes, JSON.stringify({ avatarUrl: profile.avatarUrl ?? null })],
  );
  return { brandId: stored.brand_id, username: profile.displayName ?? null };
}

export async function hasTikTokConnection(brandId: string): Promise<boolean> {
  if (config.TIKTOK_ACCESS_TOKEN) return true;
  const result = await db.query(
    `SELECT 1 FROM social_connections
     WHERE brand_id=$1 AND platform='tiktok' AND status='connected' AND refresh_token_expires_at > now()`,
    [brandId],
  );
  return Boolean(result.rowCount);
}

export async function getTikTokConnectionStatus(brandId: string): Promise<{ connected: boolean; username: string | null; source: 'oauth' | 'environment' | null }> {
  const result = await db.query<{ account_username: string | null }>(
    `SELECT account_username FROM social_connections
     WHERE brand_id=$1 AND platform='tiktok' AND status='connected' AND refresh_token_expires_at > now()`,
    [brandId],
  );
  if (result.rows[0]) return { connected: true, username: result.rows[0].account_username, source: 'oauth' };
  if (config.TIKTOK_ACCESS_TOKEN) return { connected: true, username: null, source: 'environment' };
  return { connected: false, username: null, source: null };
}

export async function getTikTokAccessToken(brandId: string): Promise<string> {
  const result = await db.query<ConnectionRow>(
    `SELECT access_token_encrypted,refresh_token_encrypted,access_token_expires_at,refresh_token_expires_at
     FROM social_connections WHERE brand_id=$1 AND platform='tiktok' AND status='connected'`,
    [brandId],
  );
  const connection = result.rows[0];
  if (!connection) {
    if (config.TIKTOK_ACCESS_TOKEN) return config.TIKTOK_ACCESS_TOKEN;
    throw new Error('Conecte a conta TikTok no painel antes de publicar');
  }
  if (connection.access_token_expires_at.getTime() > Date.now() + 5 * 60_000) {
    return decryptTikTokToken(connection.access_token_encrypted);
  }
  if (connection.refresh_token_expires_at.getTime() <= Date.now()) {
    await db.query("UPDATE social_connections SET status='revoked',updated_at=now() WHERE brand_id=$1 AND platform='tiktok'", [brandId]);
    throw new Error('A autorização do TikTok expirou. Conecte a conta novamente.');
  }
  ensureOAuthConfigured();
  const refreshed = await exchangeToken({
    client_key: config.TIKTOK_CLIENT_KEY,
    client_secret: config.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: decryptTikTokToken(connection.refresh_token_encrypted),
  });
  const accessExpiresAt = new Date(Date.now() + Number(refreshed.expires_in ?? 86_400) * 1_000);
  const refreshExpiresAt = new Date(Date.now() + Number(refreshed.refresh_expires_in ?? 31_536_000) * 1_000);
  await db.query(
    `UPDATE social_connections SET account_id=$2,access_token_encrypted=$3,refresh_token_encrypted=$4,
       access_token_expires_at=$5,refresh_token_expires_at=$6,scopes=$7,status='connected',updated_at=now()
     WHERE brand_id=$1 AND platform='tiktok'`,
    [brandId, refreshed.open_id, encryptTikTokToken(refreshed.access_token!), encryptTikTokToken(refreshed.refresh_token!), accessExpiresAt, refreshExpiresAt, (refreshed.scope ?? '').split(',').map((scope) => scope.trim()).filter(Boolean)],
  );
  return refreshed.access_token!;
}
