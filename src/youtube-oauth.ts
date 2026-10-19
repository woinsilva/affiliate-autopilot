import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

const requiredScope = 'https://www.googleapis.com/auth/youtube.upload';
const tokenUrl = 'https://oauth2.googleapis.com/token';

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type ConnectionRow = {
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
};

function ensureOAuthConfigured(): void {
  if (!config.YOUTUBE_CLIENT_ID || !config.YOUTUBE_CLIENT_SECRET) {
    throw new Error('Informe YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no arquivo .env');
  }
}

function encryptionKey(): Buffer {
  ensureOAuthConfigured();
  return createHash('sha256').update(`affiliate-autopilot:youtube:${config.YOUTUBE_CLIENT_SECRET}`).digest();
}

function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptToken(value: string): string {
  const [ivEncoded, tagEncoded, encryptedEncoded] = value.split('.');
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) throw new Error('Token do YouTube armazenado em formato inválido');
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
  if (!response.ok || result.error || !result.access_token) {
    throw new Error(`YouTube OAuth falhou: ${result.error_description ?? result.error ?? response.status}`);
  }
  return result;
}

async function fetchChannel(accessToken: string): Promise<{ id?: string; title?: string; thumbnailUrl?: string }> {
  try {
    const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true&maxResults=1', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return {};
    const result = await response.json() as { items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }> };
    const channel = result.items?.[0];
    return { id: channel?.id, title: channel?.snippet?.title, thumbnailUrl: channel?.snippet?.thumbnails?.default?.url };
  } catch {
    return {};
  }
}

export async function createYouTubeAuthorization(brandId: string): Promise<string> {
  ensureOAuthConfigured();
  const state = randomBytes(32).toString('base64url');
  await db.query('DELETE FROM oauth_sessions WHERE expires_at < now()');
  await db.query(
    `INSERT INTO oauth_sessions (state,brand_id,platform,code_verifier,expires_at)
     VALUES ($1,$2,'youtube','not-used',now() + interval '10 minutes')`,
    [state, brandId],
  );
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.YOUTUBE_CLIENT_ID,
    redirect_uri: config.YOUTUBE_REDIRECT_URI,
    response_type: 'code',
    scope: requiredScope,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  }).toString();
  return url.toString();
}

export async function completeYouTubeAuthorization(input: { state: string; code: string }): Promise<{ brandId: string; channelTitle: string | null }> {
  ensureOAuthConfigured();
  const session = await db.query<{ brand_id: string; expires_at: Date }>(
    `DELETE FROM oauth_sessions WHERE state=$1 AND platform='youtube' RETURNING brand_id,expires_at`,
    [input.state],
  );
  const stored = session.rows[0];
  if (!stored) throw new Error('A autorização expirou ou não pertence a esta sessão. Tente conectar novamente.');
  if (stored.expires_at.getTime() <= Date.now()) throw new Error('A autorização expirou. Tente conectar novamente.');
  const token = await exchangeToken({
    client_id: config.YOUTUBE_CLIENT_ID,
    client_secret: config.YOUTUBE_CLIENT_SECRET,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: config.YOUTUBE_REDIRECT_URI,
  });
  if (!token.refresh_token) throw new Error('O Google não retornou um refresh token. Revogue o acesso anterior e conecte novamente.');
  const scopes = (token.scope ?? '').split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.includes(requiredScope)) throw new Error('A conta não autorizou a permissão necessária para enviar vídeos.');
  const channel = await fetchChannel(token.access_token!);
  const expiresAt = new Date(Date.now() + Number(token.expires_in ?? 3_600) * 1_000);
  const refreshExpiresAt = new Date(Date.now() + Number(token.refresh_token_expires_in ?? 10 * 365 * 24 * 60 * 60) * 1_000);
  await db.query(
    `INSERT INTO social_connections
       (brand_id,platform,account_id,account_username,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,refresh_token_expires_at,scopes,metadata,status)
     VALUES ($1,'youtube',$2,$3,$4,$5,$6,$7,$8,$9,'connected')
     ON CONFLICT (brand_id,platform) DO UPDATE SET
       account_id=excluded.account_id,account_username=excluded.account_username,
       access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,
       access_token_expires_at=excluded.access_token_expires_at,refresh_token_expires_at=excluded.refresh_token_expires_at,
       scopes=excluded.scopes,metadata=excluded.metadata,status='connected',updated_at=now()`,
    [stored.brand_id, channel.id ?? 'authorized-channel', channel.title ?? null, encryptToken(token.access_token!), encryptToken(token.refresh_token), expiresAt, refreshExpiresAt, scopes, JSON.stringify({ thumbnailUrl: channel.thumbnailUrl ?? null })],
  );
  return { brandId: stored.brand_id, channelTitle: channel.title ?? null };
}

export async function getYouTubeConnectionStatus(brandId: string): Promise<{ connected: boolean; channelTitle: string | null; source: 'oauth' | 'environment' | null }> {
  const result = await db.query<{ account_username: string | null }>(
    `SELECT account_username FROM social_connections
     WHERE brand_id=$1 AND platform='youtube' AND status='connected'`,
    [brandId],
  );
  if (result.rows[0]) return { connected: true, channelTitle: result.rows[0].account_username, source: 'oauth' };
  if (config.YOUTUBE_REFRESH_TOKEN) return { connected: true, channelTitle: null, source: 'environment' };
  return { connected: false, channelTitle: null, source: null };
}

export async function getYouTubeAccessToken(brandId: string): Promise<string> {
  const result = await db.query<ConnectionRow>(
    `SELECT access_token_encrypted,refresh_token_encrypted,access_token_expires_at,refresh_token_expires_at
     FROM social_connections WHERE brand_id=$1 AND platform='youtube' AND status='connected'`,
    [brandId],
  );
  const connection = result.rows[0];
  if (!connection) {
    if (!config.YOUTUBE_REFRESH_TOKEN) throw new Error('Conecte o canal do YouTube no painel antes de publicar');
    const token = await exchangeToken({
      client_id: config.YOUTUBE_CLIENT_ID,
      client_secret: config.YOUTUBE_CLIENT_SECRET,
      refresh_token: config.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    return token.access_token!;
  }
  if (connection.access_token_expires_at.getTime() > Date.now() + 5 * 60_000) return decryptToken(connection.access_token_encrypted);
  try {
    const refreshed = await exchangeToken({
      client_id: config.YOUTUBE_CLIENT_ID,
      client_secret: config.YOUTUBE_CLIENT_SECRET,
      refresh_token: decryptToken(connection.refresh_token_encrypted),
      grant_type: 'refresh_token',
    });
    const accessExpiresAt = new Date(Date.now() + Number(refreshed.expires_in ?? 3_600) * 1_000);
    const refreshToken = refreshed.refresh_token ?? decryptToken(connection.refresh_token_encrypted);
    const refreshExpiresAt = refreshed.refresh_token_expires_in
      ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1_000)
      : connection.refresh_token_expires_at;
    await db.query(
      `UPDATE social_connections SET access_token_encrypted=$2,refresh_token_encrypted=$3,
         access_token_expires_at=$4,refresh_token_expires_at=$5,scopes=$6,status='connected',updated_at=now()
       WHERE brand_id=$1 AND platform='youtube'`,
      [brandId, encryptToken(refreshed.access_token!), encryptToken(refreshToken), accessExpiresAt, refreshExpiresAt, (refreshed.scope ?? '').split(/\s+/).filter(Boolean)],
    );
    return refreshed.access_token!;
  } catch (error) {
    await db.query("UPDATE social_connections SET status='revoked',updated_at=now() WHERE brand_id=$1 AND platform='youtube'", [brandId]);
    throw error;
  }
}
