import { createHash, randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { config } from './config.js';
import { getTikTokAccessToken } from './tiktok-oauth.js';
import { getYouTubeAccessToken } from './youtube-oauth.js';

export type ProductCandidate = {
  externalId: string; title: string; url: string; affiliateUrl: string; imageUrl?: string; price: number; score: number; metadata: Record<string, unknown>;
};

const mockProducts: ProductCandidate[] = [
  { externalId: 'MLB-MOCK-001', title: 'Organizador giratório de maquiagem', url: 'https://example.invalid/products/organizador', affiliateUrl: 'https://example.invalid/affiliate/organizador', price: 79.9, score: 9.2, metadata: { orders: 1240, rating: 4.8, source: 'mock' } },
  { externalId: 'MLB-MOCK-002', title: 'Luminária LED com sensor', url: 'https://example.invalid/products/luminaria', affiliateUrl: 'https://example.invalid/affiliate/luminaria', price: 39.9, score: 8.7, metadata: { orders: 880, rating: 4.7, source: 'mock' } },
  { externalId: 'MLB-MOCK-003', title: 'Mini seladora portátil', url: 'https://example.invalid/products/seladora', affiliateUrl: 'https://example.invalid/affiliate/seladora', price: 29.9, score: 8.4, metadata: { orders: 2200, rating: 4.6, source: 'mock' } },
];

export async function discoverProducts(): Promise<ProductCandidate[]> {
  if (config.PRODUCT_PROVIDER === 'manual') return [];
  if (config.PRODUCT_PROVIDER === 'mercado-livre') {
    throw new Error('Mercado Livre live ainda requer credenciais e aprovação do contrato de afiliados; use PRODUCT_PROVIDER=mock');
  }
  return mockProducts;
}

export function createProductVideoPrompt(title: string): string {
  return `Crie uma apresentação publicitária profissional e cinematográfica de ${title} a partir da imagem de referência. Mostre somente o produto. A imagem é a fonte de verdade e a composição do produto deve permanecer travada: preserve exatamente a quantidade de peças, os tipos de peças, tampas, cabos, acessórios, cores, materiais, proporções, formatos e disposição visíveis na foto. Não crie, remova, duplique, substitua, transforme, abra ou feche nenhuma peça. Não revele lados ou detalhes que não estejam visíveis na referência e não reorganize o conjunto. Anime apenas a câmera e a iluminação, usando um movimento muito suave de aproximação ou paralaxe discreta sobre a composição original, sem rotação dos produtos. Mantenha todo o conjunto visível e reconhecível durante o vídeo. Não inclua pessoas, mãos, fala, narração, diálogo, música com voz, texto na tela, legendas, letras, preços, promoções, chamadas para ação, menções a links, interfaces, marcas d'água ou elementos gráficos. Resultado limpo, sofisticado, fotorrealista e fiel ao item que será vendido.`;
}

export function createCopy(title: string, affiliateUrl: string): { hook: string; script: string; caption: string; cta: string } {
  return {
    hook: `O achadinho que está facilitando a rotina: ${title}`,
    script: createProductVideoPrompt(title),
    caption: `✨ ${title}\n\nUm achado prático para deixar a rotina mais simples. Confira preço e disponibilidade no link. Como afiliados, podemos receber comissão sem custo extra para você.\n\n${affiliateUrl}\n\n#achadinhos #ofertas #dicadecompra`,
    cta: 'Confira o link e veja se ainda está disponível.',
  };
}

export type VideoResult = { externalId: string; status: 'processing' | 'completed' | 'failed'; videoUrl: string | null; error?: string; estimatedCredit?: number; usedCredit?: number; raw: Record<string, unknown> };
export type SnapGenAccount = { isActive: boolean; planId: string | null; availableCredit: number; lockedCredit: number; totalCredit: number; benefits: Array<{ name: string; isActive: boolean; expiresAt: string | null; estimatedRemaining: number }> };
export type VideoModelCapability = {
  id: string;
  family: string;
  supportsImageToVideo: boolean;
  resolutions: string[];
  aspectRatios: string[];
  durations: number[] | { min: number; max: number };
  modes: string[];
  maxReferenceImages: number;
};

export async function listVideoModels(): Promise<VideoModelCapability[]> {
  if (!config.SNAPGEN_API_KEY) throw new Error('SNAPGEN_API_KEY is required');
  const response = await fetch(`${config.SNAPGEN_BASE_URL}/video/models`, {
    headers: { 'x-api-key': config.SNAPGEN_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SnapGen models returned ${response.status}`);
  const body = await response.json() as { models?: VideoModelCapability[] };
  return Array.isArray(body.models) ? body.models : [];
}

export async function getSnapGenAccount(): Promise<SnapGenAccount> {
  if (!config.SNAPGEN_API_KEY) throw new Error('SNAPGEN_API_KEY is required');
  const response = await fetch(`${config.SNAPGEN_BASE_URL}/video/account`, {
    headers: { 'x-api-key': config.SNAPGEN_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SnapGen account returned ${response.status}`);
  return await response.json() as SnapGenAccount;
}

export async function generateVideo(input: { title: string; script: string; imageUrl?: string; idempotencyKey?: string; model?: string; duration?: number; aspectRatio?: string; resolution?: string; mode?: string }): Promise<VideoResult> {
  if (config.SNAPGEN_MODE === 'mock') {
    const id = createHash('sha256').update(`${input.title}:${input.script}`).digest('hex').slice(0, 20);
    return { externalId: `mock-${id}`, status: 'completed', videoUrl: `https://example.invalid/videos/${id}.mp4`, raw: { provider: 'mock', deterministic: true } };
  }
  if (!config.ALLOW_PAID_OPERATIONS) throw new Error('Paid SnapGen operation blocked: set ALLOW_PAID_OPERATIONS=true explicitly');
  if (!config.SNAPGEN_API_KEY) throw new Error('SNAPGEN_API_KEY is required');
  const response = await fetch(`${config.SNAPGEN_BASE_URL}/video/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.SNAPGEN_API_KEY, 'x-idempotency-key': createHash('sha256').update(`${input.script}:${input.idempotencyKey ?? ''}`).digest('hex') },
    body: JSON.stringify({
      prompt: input.script,
      model: input.model ?? config.SNAPGEN_MODEL,
      duration: input.duration ?? config.SNAPGEN_DURATION_SECONDS,
      aspect_ratio: input.aspectRatio ?? config.SNAPGEN_ASPECT_RATIO,
      ...(input.resolution === '' ? {} : { resolution: input.resolution ?? config.SNAPGEN_RESOLUTION }),
      ...(input.mode ? { mode: input.mode } : {}),
      ref_images: input.imageUrl ? [input.imageUrl] : [],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`SnapGen middleware returned ${response.status}`);
  const raw = await response.json() as Record<string, unknown>;
  const status = raw.status === 'completed' ? 'completed' : raw.status === 'failed' ? 'failed' : 'processing';
  return { externalId: String(raw.uuid), status, videoUrl: typeof raw.videoUrl === 'string' ? raw.videoUrl : null, error: typeof raw.error === 'string' ? raw.error : undefined, estimatedCredit: typeof raw.estimatedCredit === 'number' ? raw.estimatedCredit : undefined, usedCredit: typeof raw.usedCredit === 'number' ? raw.usedCredit : undefined, raw };
}

export async function pollVideo(uuid: string): Promise<VideoResult> {
  const response = await fetch(`${config.SNAPGEN_BASE_URL}/video/${encodeURIComponent(uuid)}`, {
    headers: { 'x-api-key': config.SNAPGEN_API_KEY }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SnapGen status returned ${response.status}`);
  const raw = await response.json() as Record<string, unknown>;
  const status = raw.status === 'completed' ? 'completed' : raw.status === 'failed' ? 'failed' : 'processing';
  return { externalId: uuid, status, videoUrl: typeof raw.videoUrl === 'string' ? raw.videoUrl : null, error: typeof raw.error === 'string' ? raw.error : undefined, estimatedCredit: typeof raw.estimatedCredit === 'number' ? raw.estimatedCredit : undefined, usedCredit: typeof raw.usedCredit === 'number' ? raw.usedCredit : undefined, raw };
}

export type PublishResult = { externalId: string; url: string; raw: Record<string, unknown> };

export class DefinitivePublishError extends Error {}

export class PublicationRateLimitError extends Error {
  constructor(message: string, public readonly retryAt: Date, public readonly limitKind: string) {
    super(message);
    this.name = 'PublicationRateLimitError';
  }
}

function retryAfterHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1_000);
}

type InstagramContainerStatus = {
  id?: string;
  status?: string;
  status_code?: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
};

function instagramUrl(path: string): string {
  return `https://graph.instagram.com/${config.META_GRAPH_VERSION}/${path}`;
}

async function instagramError(response: Response, action: string): Promise<Error> {
  let detail = '';
  let code: number | undefined;
  let subcode: number | undefined;
  try {
    const body = await response.json() as { error?: { message?: string; code?: number; error_subcode?: number } };
    if (body.error?.message) detail = `: ${body.error.message}`;
    if (body.error?.code) detail += ` (code ${body.error.code})`;
    code = body.error?.code;
    subcode = body.error?.error_subcode;
  } catch {
    // The HTTP status is still useful if Meta did not return JSON.
  }
  if ([4, 17, 32, 613, 80002].includes(code ?? 0) || (code === 9 && subcode === 2207042) || response.status === 429) {
    return new PublicationRateLimitError(`O Instagram atingiu um limite temporário de publicação${detail}.`, retryAfterHours(1), 'instagram_api_limit');
  }
  return new Error(`Instagram ${action} returned ${response.status}${detail}`);
}

export type InstagramPublishingLimit = { usage: number; total: number; durationSeconds: number; remaining: number };

export async function getInstagramPublishingLimit(): Promise<InstagramPublishingLimit | null> {
  if (!config.META_ACCESS_TOKEN || !config.INSTAGRAM_ACCOUNT_ID) return null;
  const accountId = encodeURIComponent(config.INSTAGRAM_ACCOUNT_ID);
  const response = await fetch(instagramUrl(`${accountId}/content_publishing_limit?fields=quota_usage,config`), {
    headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await instagramError(response, 'publishing limit query');
  const body = await response.json() as { data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }> };
  const limit = body.data?.[0];
  const usage = Number(limit?.quota_usage);
  const total = Number(limit?.config?.quota_total);
  const durationSeconds = Number(limit?.config?.quota_duration);
  if (!Number.isFinite(usage) || !Number.isFinite(total) || total <= 0) return null;
  return { usage, total, durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 86_400, remaining: Math.max(0, total - usage) };
}

export async function waitForInstagramContainer(
  containerId: string,
  fetchImpl: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<InstagramContainerStatus> {
  const pollMilliseconds = config.INSTAGRAM_CONTAINER_POLL_SECONDS * 1_000;
  const deadline = Date.now() + config.INSTAGRAM_CONTAINER_TIMEOUT_SECONDS * 1_000;

  while (Date.now() < deadline) {
    const response = await fetchImpl(instagramUrl(`${encodeURIComponent(containerId)}?fields=id,status,status_code`), {
      headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await instagramError(response, 'container status');
    const status = await response.json() as InstagramContainerStatus;
    if (status.status_code === 'FINISHED' || status.status_code === 'PUBLISHED') return status;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Instagram container ${status.status_code.toLowerCase()}: ${status.status ?? 'no details returned'}`);
    }
    await wait(pollMilliseconds);
  }

  throw new Error(`Instagram container was not ready after ${config.INSTAGRAM_CONTAINER_TIMEOUT_SECONDS} seconds`);
}

export async function publishInstagram(input: { videoUrl: string; caption: string; imageUrls?: string[] }): Promise<PublishResult> {
  if (config.PUBLISH_MODE === 'mock') {
    const id = createHash('sha256').update(`${input.videoUrl}:${input.caption}`).digest('hex').slice(0, 16);
    return { externalId: `ig-mock-${id}`, url: `https://example.invalid/instagram/${id}`, raw: { provider: 'mock' } };
  }
  if (!config.ALLOW_REAL_PUBLISHING) throw new Error('Real publishing blocked: set ALLOW_REAL_PUBLISHING=true explicitly');
  if (!config.META_ACCESS_TOKEN || !config.INSTAGRAM_ACCOUNT_ID) throw new Error('Instagram credentials are required');
  const publishingLimit = await getInstagramPublishingLimit();
  if (publishingLimit && publishingLimit.remaining <= 0) {
    throw new PublicationRateLimitError(`O Instagram atingiu ${publishingLimit.usage}/${publishingLimit.total} publicações na janela móvel de ${Math.round(publishingLimit.durationSeconds / 3_600)} horas.`, retryAfterHours(1), 'instagram_content_publishing_limit');
  }
  const accountId = encodeURIComponent(config.INSTAGRAM_ACCOUNT_ID);
  const carouselImages = [...new Set(input.imageUrls ?? [])].slice(0, 10);
  const childIds: string[] = [];
  if (carouselImages.length >= 2) {
    for (const imageUrl of carouselImages) {
      const childResponse = await fetch(instagramUrl(`${accountId}/media`), {
        method: 'POST',
        headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrl, is_carousel_item: 'true' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!childResponse.ok) throw await instagramError(childResponse, 'carousel item creation');
      const child = await childResponse.json() as { id?: string };
      if (!child.id) throw new Error('Instagram não retornou o ID de uma imagem do carrossel');
      childIds.push(child.id);
    }
  }
  const createBody = childIds.length >= 2
    ? new URLSearchParams({ media_type: 'CAROUSEL', children: childIds.join(','), caption: input.caption })
    : new URLSearchParams({ media_type: 'REELS', video_url: input.videoUrl, caption: input.caption, share_to_feed: String(config.INSTAGRAM_SHARE_TO_FEED) });
  const create = await fetch(instagramUrl(`${accountId}/media`), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: createBody,
    signal: AbortSignal.timeout(60_000),
  });
  if (!create.ok) throw await instagramError(create, 'container creation');
  const container = await create.json() as { id?: string };
  if (!container.id) throw new Error('Instagram did not return a container id');

  await waitForInstagramContainer(container.id);

  const publish = await fetch(instagramUrl(`${accountId}/media_publish`), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: container.id }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!publish.ok) throw await instagramError(publish, 'publish');
  const raw = await publish.json() as Record<string, unknown>;
  const externalId = String(raw.id);
  let url = 'https://www.instagram.com/';
  try {
    const media = await fetch(instagramUrl(`${encodeURIComponent(externalId)}?fields=permalink`), {
      headers: { authorization: `Bearer ${config.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (media.ok) {
      const details = await media.json() as { permalink?: string };
      if (details.permalink) url = details.permalink;
    }
  } catch {
    // Publishing already succeeded; permalink enrichment must never trigger a duplicate retry.
  }
  return { externalId, url, raw: { ...raw, containerId: container.id, mediaType: childIds.length >= 2 ? 'CAROUSEL' : 'REELS' } };
}

async function fetchPublishableVideo(videoUrl: string): Promise<ArrayBuffer> {
  const local = /^\/api\/media\/([0-9a-f-]{36})\.mp4$/i.exec(videoUrl);
  const sourceUrl = local ? `http://api:3000/media/${local[1]}.mp4` : videoUrl;
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Não foi possível baixar o vídeo para publicação (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error('O vídeo para publicação está vazio');
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('O vídeo excede o limite de 64 MB desta integração');
  return bytes;
}

type TikTokResponse<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string } };

export type TikTokCreatorInfo = {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
};

export type TikTokPublishSettings = {
  title: string;
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  commercialContent: 'none' | 'your_brand' | 'branded_content' | 'both';
  isAiGenerated: boolean;
  musicUsageAccepted: boolean;
};

async function tiktokRequest<T>(path: string, body: Record<string, unknown>, accessToken: string, safeToRetryPublication = false): Promise<T> {
  const response = await fetch(`https://open.tiktokapis.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as TikTokResponse<T>;
  if (!response.ok || result.error?.code !== 'ok' || !result.data) {
    const errorCode = result.error?.code ?? '';
    if (safeToRetryPublication && ['spam_risk_too_many_posts', 'spam_risk_too_many_pending_share', 'reached_active_user_cap'].includes(errorCode)) {
      throw new PublicationRateLimitError(`O TikTok atingiu o limite de publicação da conta (${errorCode}).`, retryAfterHours(24), `tiktok_${errorCode}`);
    }
    if (safeToRetryPublication && (errorCode === 'rate_limit_exceeded' || response.status === 429)) {
      throw new PublicationRateLimitError('O TikTok limitou temporariamente as solicitações desta conta.', new Date(Date.now() + 5 * 60_000), 'tiktok_request_rate');
    }
    throw new DefinitivePublishError(`TikTok ${path} falhou: ${result.error?.code ?? response.status} ${result.error?.message ?? ''}`.trim());
  }
  return result.data;
}

export async function getTikTokCreatorInfo(brandId: string): Promise<TikTokCreatorInfo> {
  const accessToken = await getTikTokAccessToken(brandId);
  return tiktokRequest<TikTokCreatorInfo>('/v2/post/publish/creator_info/query/', {}, accessToken, true);
}

export async function publishTikTok(input: { brandId: string; videoUrl: string; caption: string; settings: TikTokPublishSettings }): Promise<PublishResult> {
  const accessToken = await getTikTokAccessToken(input.brandId);
  const creator = await tiktokRequest<TikTokCreatorInfo>('/v2/post/publish/creator_info/query/', {}, accessToken, true);
  if (!creator.privacy_level_options?.includes(input.settings.privacyLevel)) {
    throw new DefinitivePublishError(`A conta TikTok não permite a privacidade ${input.settings.privacyLevel}`);
  }
  if (!input.settings.musicUsageAccepted) throw new DefinitivePublishError('Confirme o uso de música antes de publicar');
  if (input.settings.commercialContent === 'branded_content' && input.settings.privacyLevel === 'SELF_ONLY') {
    throw new DefinitivePublishError('Conteúdo de marca não pode usar a privacidade Somente eu');
  }
  const video = await fetchPublishableVideo(input.videoUrl);
  const initialized = await tiktokRequest<{ publish_id?: string; upload_url?: string }>('/v2/post/publish/video/init/', {
    post_info: {
      title: input.settings.title.slice(0, 2200),
      privacy_level: input.settings.privacyLevel,
      disable_duet: creator.duet_disabled || !input.settings.allowDuet,
      disable_comment: creator.comment_disabled || !input.settings.allowComment,
      disable_stitch: creator.stitch_disabled || !input.settings.allowStitch,
      video_cover_timestamp_ms: 1000,
      brand_content_toggle: ['branded_content', 'both'].includes(input.settings.commercialContent),
      brand_organic_toggle: ['your_brand', 'both'].includes(input.settings.commercialContent),
      is_aigc: input.settings.isAiGenerated,
    },
    source_info: { source: 'FILE_UPLOAD', video_size: video.byteLength, chunk_size: video.byteLength, total_chunk_count: 1 },
  }, accessToken, true);
  if (!initialized.publish_id || !initialized.upload_url) throw new Error('TikTok não retornou os dados de upload');
  const uploaded = await fetch(initialized.upload_url, {
    method: 'PUT',
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(video.byteLength),
      'content-range': `bytes 0-${video.byteLength - 1}/${video.byteLength}`,
    },
    body: video,
    signal: AbortSignal.timeout(120_000),
  });
  if (![200, 201, 206].includes(uploaded.status)) throw new Error(`TikTok upload falhou: ${uploaded.status}`);

  const deadline = Date.now() + config.TIKTOK_PUBLISH_TIMEOUT_SECONDS * 1_000;
  let lastStatus: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    lastStatus = await tiktokRequest<Record<string, unknown>>('/v2/post/publish/status/fetch/', { publish_id: initialized.publish_id }, accessToken);
    if (lastStatus.status === 'PUBLISH_COMPLETE') {
      const postIds = Array.isArray(lastStatus.publicaly_available_post_id) ? lastStatus.publicaly_available_post_id : [];
      const postId = postIds[0] ? String(postIds[0]) : initialized.publish_id;
      const username = creator.creator_username ?? 'me';
      const url = postIds[0] ? `https://www.tiktok.com/@${username}/video/${postId}` : `https://www.tiktok.com/@${username}`;
      return { externalId: postId, url, raw: { ...lastStatus, publishId: initialized.publish_id, creator: username } };
    }
    if (lastStatus.status === 'FAILED') {
      const reason = String(lastStatus.fail_reason ?? 'motivo não informado');
      if (['spam_risk_too_many_posts', 'spam_risk_too_many_pending_share', 'reached_active_user_cap'].includes(reason)) {
        throw new PublicationRateLimitError(`O TikTok adiou a publicação por limite da conta (${reason}).`, retryAfterHours(24), `tiktok_${reason}`);
      }
      throw new Error(`TikTok rejeitou a publicação: ${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.TIKTOK_POLL_SECONDS * 1_000));
  }
  throw new Error(`TikTok ainda processava a publicação após ${config.TIKTOK_PUBLISH_TIMEOUT_SECONDS} segundos`);
}

export async function publishYouTube(input: { brandId: string; videoUrl: string; title: string; description: string }): Promise<PublishResult> {
  const [accessToken, video] = await Promise.all([getYouTubeAccessToken(input.brandId), fetchPublishableVideo(input.videoUrl)]);
  const metadata = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description.slice(0, 5000),
      categoryId: '22',
      tags: ['achadinhos', 'ofertas', 'shorts'],
      defaultLanguage: 'pt-BR',
    },
    status: {
      privacyStatus: config.YOUTUBE_PRIVACY_STATUS,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    },
  };
  const initialize = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(video.byteLength),
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(30_000),
  });
  if (!initialize.ok) {
    const responseText = await initialize.text();
    let reason = '';
    try {
      const body = JSON.parse(responseText) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
      reason = body.error?.errors?.[0]?.reason ?? '';
      if (reason === 'uploadLimitExceeded') {
        throw new PublicationRateLimitError('O YouTube atingiu o limite diário de uploads deste canal.', retryAfterHours(6), 'youtube_channel_upload_limit');
      }
      if (reason === 'quotaExceeded') {
        throw new PublicationRateLimitError('O projeto do YouTube atingiu a cota diária da API.', retryAfterHours(24), 'youtube_api_quota');
      }
      throw new DefinitivePublishError(`O YouTube recusou o envio antes do upload (${initialize.status}): ${body.error?.message ?? 'motivo não informado'}`);
    } catch (error) {
      if (error instanceof DefinitivePublishError || error instanceof PublicationRateLimitError) throw error;
      throw new DefinitivePublishError(`O YouTube recusou o envio antes do upload (${initialize.status})${responseText ? `: ${responseText.slice(0, 300)}` : ''}`);
    }
  }
  const uploadUrl = initialize.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube não retornou a URL de upload');
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4', 'content-length': String(video.byteLength) },
    body: video,
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await upload.json() as Record<string, unknown>;
  if (!upload.ok || typeof raw.id !== 'string') throw new Error(`YouTube upload falhou (${upload.status})`);
  return { externalId: raw.id, url: `https://youtu.be/${raw.id}`, raw };
}

export function mockMetrics(seed: string): { views: number; likes: number; comments: number; shares: number; clicks: number; conversions: number; revenue: number } {
  const number = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const views = 1000 + number % 20000;
  return { views, likes: Math.round(views * 0.06), comments: Math.round(views * 0.004), shares: Math.round(views * 0.009), clicks: Math.round(views * 0.025), conversions: Math.round(views * 0.0015), revenue: Math.round((views * 0.0015 * 8.7) * 100) / 100 };
}

export async function sendEmail(input: { subject: string; html: string }): Promise<{ id: string; mode: 'log' | 'resend' }> {
  if (config.NOTIFICATION_MODE === 'log') {
    console.log(JSON.stringify({ message: 'notification_preview', subject: input.subject, to: config.EMAIL_TO || '(not configured)' }));
    return { id: `log-${randomUUID()}`, mode: 'log' };
  }
  if (!config.RESEND_API_KEY || !config.EMAIL_TO) throw new Error('RESEND_API_KEY and EMAIL_TO are required');
  const resend = new Resend(config.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({ from: config.EMAIL_FROM, to: config.EMAIL_TO.split(',').map((value) => value.trim()), subject: input.subject, html: input.html });
  if (error || !data) throw new Error(error?.message ?? 'Resend did not return a message id');
  return { id: data.id, mode: 'resend' };
}
