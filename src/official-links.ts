import { createHash } from 'node:crypto';
import { z } from 'zod';

const allowedAffiliateHosts = new Set(['meli.la']);
const destinationDomain = 'mercadolivre.com.br';

function isAllowedDestinationHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === destinationDomain || normalized.endsWith(`.${destinationDomain}`);
}

export const officialResolveSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(100),
});

export type ResolvedOfficialProduct = {
  affiliateUrl: string;
  destinationUrl: string;
  title: string;
  externalId: string;
  price?: number;
  currency: string;
  imageUrl?: string;
  imageUrls?: string[];
  listingVideo?: ListingVideoAnalysis;
};

export type ListingVideoAnalysis = {
  status: 'found' | 'not_found' | 'authorization_required' | 'unavailable';
  provider?: string;
  externalId?: string;
  previewUrl?: string;
  message: string;
};

export const officialProductSchema = z.object({
  affiliateUrl: z.string().url(),
  destinationUrl: z.string().url().optional(),
  title: z.string().trim().min(3).max(240),
  externalId: z.string().trim().regex(/^MLB\d{6,}$/i, 'Use um ID no formato MLB123456').optional(),
  price: z.number().nonnegative().max(10_000_000).optional(),
  imageUrl: z.string().url().optional(),
  imageUrls: z.array(z.string().url()).max(10).default([]),
  mediaPreference: z.enum(['auto', 'slideshow', 'ai']).default('auto'),
  channels: z.array(z.enum(['instagram', 'tiktok', 'youtube'])).default([]),
  labels: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  startPipeline: z.boolean().default(true),
}).superRefine((value, ctx) => {
  const affiliate = new URL(value.affiliateUrl);
  if (affiliate.protocol !== 'https:' || !allowedAffiliateHosts.has(affiliate.hostname.toLowerCase())) {
    ctx.addIssue({ code: 'custom', path: ['affiliateUrl'], message: 'Use um link oficial HTTPS do domínio meli.la' });
  }
  if (value.destinationUrl) {
    const destination = new URL(value.destinationUrl);
    if (destination.protocol !== 'https:' || !isAllowedDestinationHost(destination.hostname)) {
      ctx.addIssue({ code: 'custom', path: ['destinationUrl'], message: 'O destino deve pertencer ao Mercado Livre Brasil' });
    }
  }
  value.imageUrls.forEach((url, index) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'http2.mlstatic.com') {
      ctx.addIssue({ code: 'custom', path: ['imageUrls', index], message: 'Use imagens HTTPS do CDN oficial do Mercado Livre' });
    }
  });
  if (value.mediaPreference === 'slideshow' && value.imageUrls.length < 2) {
    ctx.addIssue({ code: 'custom', path: ['imageUrls'], message: 'Informe pelo menos duas imagens para montar o carrossel' });
  }
});

export const officialImportSchema = z.object({
  brandSlug: z.string().trim().min(1).default('achadinhos'),
  model: z.string().trim().min(1).max(100).optional(),
  duration: z.coerce.number().int().positive().max(300).optional(),
  aspectRatio: z.string().trim().min(1).max(20).optional(),
  resolution: z.string().trim().max(20).optional(),
  mode: z.string().trim().max(100).optional(),
  products: z.array(officialProductSchema).min(1).max(100),
});

export type OfficialProductInput = z.infer<typeof officialProductSchema>;

export function normalizeOfficialProduct(input: OfficialProductInput): OfficialProductInput & { generatedExternalId: string } {
  const affiliateUrl = new URL(input.affiliateUrl);
  affiliateUrl.hash = '';
  const normalizedUrl = affiliateUrl.toString();
  const generatedExternalId = input.externalId?.toUpperCase()
    ?? `MANUAL-${createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 20).toUpperCase()}`;
  return { ...input, affiliateUrl: normalizedUrl, generatedExternalId };
}

function firstJsonObjectAfter(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error('O destino não apresentou um produto recomendado');
  const start = source.indexOf('{', markerIndex + marker.length);
  if (start < 0) throw new Error('Os dados do produto estão incompletos');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('Não foi possível concluir a leitura do produto');
}

function mercadoLivrePictureUrl(id: string): string {
  return `https://http2.mlstatic.com/D_NQ_NP_${id}-F.jpg`;
}

export function parseOfficialProductPreview(html: string, affiliateUrl: string): ResolvedOfficialProduct {
  const raw = JSON.parse(firstJsonObjectAfter(html, '"polycards":[')) as {
    metadata?: { id?: unknown; url?: unknown };
    pictures?: { pictures?: Array<{ id?: unknown }> };
    components?: Array<{ type?: unknown; title?: { text?: unknown }; price?: { current_price?: { value?: unknown; currency?: unknown } } }>;
  };
  const externalId = typeof raw.metadata?.id === 'string' ? raw.metadata.id.toUpperCase() : '';
  const destinationPath = typeof raw.metadata?.url === 'string' ? raw.metadata.url : '';
  const titleComponent = raw.components?.find((component) => component.type === 'title');
  const priceComponent = raw.components?.find((component) => component.type === 'price');
  const title = typeof titleComponent?.title?.text === 'string' ? titleComponent.title.text.trim() : '';
  const price = priceComponent?.price?.current_price?.value;
  const currency = priceComponent?.price?.current_price?.currency;
  const pictureIds = (raw.pictures?.pictures ?? []).map((picture) => picture.id).filter((id): id is string => typeof id === 'string');
  const imageUrls = [...new Set(pictureIds.map(mercadoLivrePictureUrl))].slice(0, 10);
  if (!/^MLB\d{6,}$/.test(externalId) || !title || !destinationPath) throw new Error('O cartão do produto não contém os dados mínimos');
  const destinationBase = destinationPath.startsWith('http') ? destinationPath : `https://${destinationPath}`;
  const destination = new URL(destinationBase);
  destination.searchParams.set('pdp_filters', `item_id:${externalId}`);
  return {
    affiliateUrl,
    destinationUrl: destination.toString(),
    title,
    externalId,
    price: typeof price === 'number' && Number.isFinite(price) ? price : undefined,
    currency: typeof currency === 'string' ? currency : 'BRL',
    imageUrl: imageUrls[0],
    imageUrls,
  };
}

export async function resolveOfficialAffiliateLink(affiliateUrl: string): Promise<ResolvedOfficialProduct> {
  const url = new URL(affiliateUrl);
  if (url.protocol !== 'https:' || !allowedAffiliateHosts.has(url.hostname.toLowerCase())) throw new Error('Use um link oficial HTTPS do domínio meli.la');
  url.hash = '';
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'AffiliateAutopilot/0.1 (+official-link-metadata)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`O Mercado Livre respondeu HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (!isAllowedDestinationHost(finalUrl.hostname)) throw new Error('O link não terminou no Mercado Livre Brasil');
  if (/\/social\/[^/]+\/lists\/?$/i.test(finalUrl.pathname)) {
    throw new Error('Este link abre a lista do perfil, não um produto. Gere outro link a partir da página do produto.');
  }
  return parseOfficialProductPreview(await response.text(), url.toString());
}

export function parseListingVideoId(value: unknown): Omit<ListingVideoAnalysis, 'status' | 'message'> | null {
  if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'null') return null;
  const [externalId, rawProvider] = value.split(';').map((part) => part.trim());
  if (!externalId) return null;
  const provider = (rawProvider || 'mercado-livre').toLowerCase();
  const previewUrl = provider === 'youtube' ? `https://www.youtube.com/watch?v=${encodeURIComponent(externalId)}` : undefined;
  return { externalId, provider, previewUrl };
}

export async function analyzeMercadoLivreListingVideo(externalId: string, accessToken: string): Promise<ListingVideoAnalysis> {
  return (await analyzeMercadoLivreListingMedia(externalId, accessToken)).listingVideo;
}

export async function analyzeMercadoLivreListingMedia(externalId: string, accessToken: string): Promise<{ listingVideo: ListingVideoAnalysis; imageUrls: string[] }> {
  try {
    const response = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(externalId)}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { pictures?: Array<{ secure_url?: unknown; id?: unknown }>; video_id?: unknown; message?: string; error?: string };
    if (!response.ok) {
      return { imageUrls: [], listingVideo: { status: response.status === 401 || response.status === 403 ? 'authorization_required' : 'unavailable', message: `A API do Mercado Livre não permitiu analisar fotos/vídeo deste anúncio (HTTP ${response.status}: ${result.message ?? result.error ?? 'acesso negado'}). A conta conectada pode não ter permissão para este item.` } };
    }
    const imageUrls = [...new Set((result.pictures ?? []).map((picture) => {
      if (typeof picture.secure_url === 'string' && picture.secure_url.startsWith('https://http2.mlstatic.com/')) return picture.secure_url.replace(/\.webp(?:\?.*)?$/i, '.jpg');
      return typeof picture.id === 'string' ? mercadoLivrePictureUrl(picture.id) : null;
    }).filter((url): url is string => Boolean(url)))].slice(0, 10);
    const video = parseListingVideoId(result.video_id);
    return { imageUrls, listingVideo: video
      ? { status: 'found', ...video, message: 'O anúncio informa um vídeo. Confira o vínculo e os direitos de uso antes de republicar.' }
      : { status: 'not_found', message: 'O anúncio não informou vídeo próprio na API oficial.' } };
  } catch (error) {
    return { imageUrls: [], listingVideo: { status: 'unavailable', message: `Não foi possível consultar a mídia do anúncio: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
