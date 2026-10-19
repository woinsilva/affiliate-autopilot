import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

const tokenUrl = 'https://api.mercadolibre.com/oauth/token';

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  user_id?: number;
  error?: string;
  message?: string;
  error_description?: string;
};

type ConnectionRow = {
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
};

function ensureOAuthConfigured(): void {
  if (!config.MERCADO_LIVRE_CLIENT_ID || !config.MERCADO_LIVRE_CLIENT_SECRET) {
    throw new Error('Informe MERCADO_LIVRE_CLIENT_ID e MERCADO_LIVRE_CLIENT_SECRET no arquivo .env');
  }
}

function encryptionKey(): Buffer {
  ensureOAuthConfigured();
  return createHash('sha256').update(`affiliate-autopilot:mercado-livre:${config.MERCADO_LIVRE_CLIENT_SECRET}`).digest();
}

function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptToken(value: string): string {
  const [ivEncoded, tagEncoded, encryptedEncoded] = value.split('.');
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) throw new Error('Token do Mercado Livre armazenado em formato inválido');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedEncoded, 'base64url')), decipher.final()]).toString('utf8');
}

async function exchangeToken(parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as TokenResponse;
  if (!response.ok || result.error || !result.access_token || !result.refresh_token || !result.user_id) {
    throw new Error(`Mercado Livre OAuth falhou: ${result.error_description ?? result.message ?? result.error ?? response.status}`);
  }
  return result;
}

async function fetchProfile(accessToken: string): Promise<{ id?: number; nickname?: string }> {
  const response = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return {};
  return response.json() as Promise<{ id?: number; nickname?: string }>;
}

export async function createMercadoLivreAuthorization(brandId: string): Promise<string> {
  ensureOAuthConfigured();
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  await db.query('DELETE FROM oauth_sessions WHERE expires_at < now()');
  await db.query(
    `INSERT INTO oauth_sessions (state,brand_id,platform,code_verifier,expires_at)
     VALUES ($1,$2,'mercado_livre',$3,now() + interval '15 minutes')`,
    [state, brandId, codeVerifier],
  );
  const url = new URL('https://auth.mercadolivre.com.br/authorization');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.MERCADO_LIVRE_CLIENT_ID,
    redirect_uri: config.MERCADO_LIVRE_REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function parseMercadoLivreCallback(value: string): { state: string; code: string } {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Cole a URL completa exibida após a autorização do Mercado Livre.'); }
  if (url.origin !== new URL(config.MERCADO_LIVRE_REDIRECT_URI).origin) {
    throw new Error('A URL informada não pertence ao endereço de redirecionamento configurado.');
  }
  const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
  if (oauthError) throw new Error(`O Mercado Livre recusou a autorização: ${oauthError}`);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  if (!state || !code) throw new Error('A URL não contém o código e o estado da autorização.');
  return { state, code };
}

export async function completeMercadoLivreAuthorization(input: { state: string; code: string }): Promise<{ brandId: string; nickname: string | null }> {
  ensureOAuthConfigured();
  const session = await db.query<{ brand_id: string; code_verifier: string; expires_at: Date }>(
    `DELETE FROM oauth_sessions WHERE state=$1 AND platform='mercado_livre' RETURNING brand_id,code_verifier,expires_at`,
    [input.state],
  );
  const stored = session.rows[0];
  if (!stored) throw new Error('A autorização expirou ou não pertence a esta sessão. Tente conectar novamente.');
  if (stored.expires_at.getTime() <= Date.now()) throw new Error('A autorização expirou. Tente conectar novamente.');
  const token = await exchangeToken({
    grant_type: 'authorization_code',
    client_id: config.MERCADO_LIVRE_CLIENT_ID,
    client_secret: config.MERCADO_LIVRE_CLIENT_SECRET,
    code: input.code,
    redirect_uri: config.MERCADO_LIVRE_REDIRECT_URI,
    code_verifier: stored.code_verifier,
  });
  const profile = await fetchProfile(token.access_token!);
  const expiresAt = new Date(Date.now() + Number(token.expires_in ?? 21_600) * 1_000);
  const refreshExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000);
  const scopes = (token.scope ?? '').split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  await db.query(
    `INSERT INTO social_connections
       (brand_id,platform,account_id,account_username,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,refresh_token_expires_at,scopes,metadata,status)
     VALUES ($1,'mercado_livre',$2,$3,$4,$5,$6,$7,$8,$9,'connected')
     ON CONFLICT (brand_id,platform) DO UPDATE SET
       account_id=excluded.account_id,account_username=excluded.account_username,
       access_token_encrypted=excluded.access_token_encrypted,refresh_token_encrypted=excluded.refresh_token_encrypted,
       access_token_expires_at=excluded.access_token_expires_at,refresh_token_expires_at=excluded.refresh_token_expires_at,
       scopes=excluded.scopes,metadata=excluded.metadata,status='connected',updated_at=now()`,
    [stored.brand_id, String(profile.id ?? token.user_id), profile.nickname ?? null, encryptToken(token.access_token!), encryptToken(token.refresh_token!), expiresAt, refreshExpiresAt, scopes, JSON.stringify({ redirectUri: config.MERCADO_LIVRE_REDIRECT_URI })],
  );
  return { brandId: stored.brand_id, nickname: profile.nickname ?? null };
}

export async function getMercadoLivreConnectionStatus(brandId: string): Promise<{ connected: boolean; nickname: string | null }> {
  const result = await db.query<{ account_username: string | null }>(
    `SELECT account_username FROM social_connections WHERE brand_id=$1 AND platform='mercado_livre' AND status='connected'`,
    [brandId],
  );
  return { connected: Boolean(result.rows[0]), nickname: result.rows[0]?.account_username ?? null };
}

export async function getMercadoLivreAccessToken(brandId: string): Promise<string> {
  ensureOAuthConfigured();
  const result = await db.query<ConnectionRow>(
    `SELECT access_token_encrypted,refresh_token_encrypted,access_token_expires_at,refresh_token_expires_at
     FROM social_connections WHERE brand_id=$1 AND platform='mercado_livre' AND status='connected'`,
    [brandId],
  );
  const connection = result.rows[0];
  if (!connection) throw new Error('Conecte a conta do Mercado Livre no painel para analisar os vídeos dos anúncios.');
  if (connection.access_token_expires_at.getTime() > Date.now() + 5 * 60_000) return decryptToken(connection.access_token_encrypted);
  try {
    const refreshed = await exchangeToken({
      grant_type: 'refresh_token',
      client_id: config.MERCADO_LIVRE_CLIENT_ID,
      client_secret: config.MERCADO_LIVRE_CLIENT_SECRET,
      refresh_token: decryptToken(connection.refresh_token_encrypted),
    });
    const accessExpiresAt = new Date(Date.now() + Number(refreshed.expires_in ?? 21_600) * 1_000);
    const refreshExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000);
    await db.query(
      `UPDATE social_connections SET account_id=$2,access_token_encrypted=$3,refresh_token_encrypted=$4,
         access_token_expires_at=$5,refresh_token_expires_at=$6,scopes=$7,status='connected',updated_at=now()
       WHERE brand_id=$1 AND platform='mercado_livre'`,
      [brandId, String(refreshed.user_id), encryptToken(refreshed.access_token!), encryptToken(refreshed.refresh_token!), accessExpiresAt, refreshExpiresAt, (refreshed.scope ?? '').split(/\s+/).filter(Boolean)],
    );
    return refreshed.access_token!;
  } catch (error) {
    await db.query("UPDATE social_connections SET status='revoked',updated_at=now() WHERE brand_id=$1 AND platform='mercado_livre'", [brandId]);
    throw error;
  }
}
