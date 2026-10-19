import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import { config, validateLiveConfiguration } from './config.js';
import { brandBySlug, db, event } from './db.js';
import { enqueue, queueNames } from './queues.js';
import { analyzeMercadoLivreListingMedia, normalizeOfficialProduct, officialImportSchema, officialResolveSchema, resolveOfficialAffiliateLink } from './official-links.js';
import { readMediaFile } from './media.js';
import { createProductVideoPrompt, getInstagramPublishingLimit, getSnapGenAccount, getTikTokCreatorInfo, listVideoModels } from './providers.js';
import { duplicatePipelineAction, type DuplicatePipelineAction } from './pipeline.js';
import { completeTikTokAuthorization, createTikTokAuthorization, getTikTokConnectionStatus, hasTikTokConnection } from './tiktok-oauth.js';
import { completeYouTubeAuthorization, createYouTubeAuthorization, getYouTubeConnectionStatus } from './youtube-oauth.js';
import { completeMercadoLivreAuthorization, createMercadoLivreAuthorization, getMercadoLivreAccessToken, getMercadoLivreConnectionStatus, parseMercadoLivreCallback } from './mercado-livre-oauth.js';

type VideoSettings = { model: string; duration: number; aspectRatio: string; resolution: string; mode: string };
class RequestValidationError extends Error {}

const tiktokPublishSettingsSchema = z.object({
  title: z.string().trim().min(1).max(2200),
  privacyLevel: z.enum(['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']),
  allowComment: z.boolean().default(false),
  allowDuet: z.boolean().default(false),
  allowStitch: z.boolean().default(false),
  commercialContent: z.enum(['none', 'your_brand', 'branded_content', 'both']).default('none'),
  isAiGenerated: z.boolean(),
  musicUsageAccepted: z.literal(true),
});

async function retryFailedContent(content: { id: string; brand_id: string; title: string }, video: VideoSettings): Promise<number> {
  const attempts = await db.query<{ count: number }>(
    `SELECT count(*)::int count FROM operation_ledger WHERE idempotency_key=$1 OR idempotency_key LIKE $2`,
    [`snapgen:generate:${content.id}`, `snapgen:generate:${content.id}:retry:%`],
  );
  const attempt = attempts.rows[0]!.count + 1;
  const operationKey = `snapgen:generate:${content.id}:retry:${attempt}`;
  const videoPrompt = createProductVideoPrompt(content.title);
  const reset = await db.query(
    "UPDATE content_items SET status='scripted',media_kind='ai_video',script=$2,video_url=NULL,qa_score=NULL,qa_notes='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='failed' RETURNING id",
    [content.id, videoPrompt],
  );
  if (!reset.rowCount) throw new RequestValidationError('A tentativa anterior não está mais no estado de falha. Atualize a página para conferir o andamento.');
  try {
    await enqueue(queueNames.snapgen, 'generate-video', {
      brandId: content.brand_id,
      contentId: content.id,
      operationKey,
      providerIdempotencyKey: `${content.id}:retry:${attempt}`,
      ...video,
    }, `snapgen-retry-${content.id}-${attempt}`);
  } catch (error) {
    await db.query("UPDATE content_items SET status='failed',updated_at=now() WHERE id=$1 AND status='scripted'", [content.id]);
    throw error;
  }
  return attempt;
}

async function requestedVideoSettings(value: Record<string, unknown>): Promise<VideoSettings> {
  const models = (await listVideoModels()).filter((model) => model.supportsImageToVideo);
  const requestedModel = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : config.SNAPGEN_MODEL;
  const model = models.find((candidate) => candidate.id === requestedModel);
  if (!model) throw new RequestValidationError(`O modelo ${requestedModel} não está disponível para geração com imagem`);
  const fallbackDuration = Array.isArray(model.durations) ? model.durations[0]! : model.durations.min;
  const duration = typeof value.duration === 'number' ? value.duration : Number(value.duration ?? (Array.isArray(model.durations) && model.durations.includes(config.SNAPGEN_DURATION_SECONDS) ? config.SNAPGEN_DURATION_SECONDS : fallbackDuration));
  const durationSupported = Number.isInteger(duration) && (Array.isArray(model.durations) ? model.durations.includes(duration) : duration >= model.durations.min && duration <= model.durations.max);
  if (!durationSupported) throw new RequestValidationError(`O modelo ${model.id} não aceita duração de ${duration}s`);
  const aspectRatio = typeof value.aspectRatio === 'string' && value.aspectRatio ? value.aspectRatio : (model.aspectRatios.includes(config.SNAPGEN_ASPECT_RATIO) ? config.SNAPGEN_ASPECT_RATIO : model.aspectRatios[0]);
  if (!aspectRatio || !model.aspectRatios.includes(aspectRatio)) throw new RequestValidationError(`O modelo ${model.id} não aceita o formato ${aspectRatio ?? 'informado'}`);
  const defaultResolution = model.resolutions.includes(config.SNAPGEN_RESOLUTION) ? config.SNAPGEN_RESOLUTION : (model.resolutions[0] ?? '');
  const resolution = typeof value.resolution === 'string' ? value.resolution : defaultResolution;
  if ((resolution && !model.resolutions.includes(resolution)) || (!resolution && model.resolutions.length > 0)) throw new RequestValidationError(`O modelo ${model.id} não aceita a resolução ${resolution || 'automática'}`);
  const mode = typeof value.mode === 'string' ? value.mode : (model.modes[0] ?? '');
  if ((mode && !model.modes.includes(mode)) || (!mode && model.modes.length > 0)) throw new RequestValidationError(`O modelo ${model.id} não aceita o modo ${mode || 'padrão'}`);
  return { model: model.id, duration, aspectRatio, resolution, mode };
}

export function createApp(): express.Express {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_request, response) => {
    try {
      await db.query('SELECT 1');
      response.json({ status: 'ok', role: config.PROCESS_ROLE, timestamp: new Date().toISOString() });
    } catch (error) {
      response.status(503).json({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/media/:filename', async (request, response) => {
    const match = /^([0-9a-f-]{36})\.mp4$/i.exec(request.params.filename);
    if (!match) { response.status(404).end(); return; }
    try {
      const bytes = await readMediaFile(match[1]!);
      response.type('video/mp4').set('Cache-Control', 'private, max-age=3600').send(bytes);
    } catch { response.status(404).end(); }
  });

  app.get('/config/status', async (_request, response) => {
    const brand = await brandBySlug();
    const [tiktok, youtube, mercadoLivre] = await Promise.all([getTikTokConnectionStatus(brand.id), getYouTubeConnectionStatus(brand.id), getMercadoLivreConnectionStatus(brand.id)]);
    response.json({
      modes: { products: config.PRODUCT_PROVIDER, snapgen: config.SNAPGEN_MODE, publishing: config.PUBLISH_MODE, metrics: config.METRICS_MODE, notifications: config.NOTIFICATION_MODE },
      safeguards: { paidOperationsAllowed: config.ALLOW_PAID_OPERATIONS, realPublishingAllowed: config.ALLOW_REAL_PUBLISHING },
      approval: { automaticAfterQa: config.AUTO_PUBLISH_AFTER_QA },
      connections: {
        instagram: Boolean(config.META_ACCESS_TOKEN && config.INSTAGRAM_ACCOUNT_ID),
        tiktok: tiktok.connected,
        tiktokAccount: tiktok.username,
        tiktokSource: tiktok.source,
        tiktokOAuthReady: Boolean(config.TIKTOK_CLIENT_KEY && config.TIKTOK_CLIENT_SECRET),
        youtube: youtube.connected,
        youtubeAccount: youtube.channelTitle,
        youtubeSource: youtube.source,
        youtubeOAuthReady: Boolean(config.YOUTUBE_CLIENT_ID && config.YOUTUBE_CLIENT_SECRET),
        mercadoLivre: mercadoLivre.connected,
        mercadoLivreAccount: mercadoLivre.nickname,
        mercadoLivreOAuthReady: Boolean(config.MERCADO_LIVRE_CLIENT_ID && config.MERCADO_LIVRE_CLIENT_SECRET),
      },
      issues: validateLiveConfiguration(),
    });
  });

  app.get('/integrations/tiktok/authorize', async (request, response) => {
    try {
      const brand = await brandBySlug(typeof request.query.brandSlug === 'string' ? request.query.brandSlug : 'achadinhos');
      response.redirect(await createTikTokAuthorization(brand.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.redirect(`/?tiktok=error&message=${encodeURIComponent(message)}`);
    }
  });

  app.get('/integrations/tiktok/creator-info', async (request, response) => {
    const brand = await brandBySlug(typeof request.query.brandSlug === 'string' ? request.query.brandSlug : 'achadinhos');
    response.json(await getTikTokCreatorInfo(brand.id));
  });

  app.get(['/integrations/tiktok/callback', '/integrations/tiktok/callback/'], async (request, response) => {
    const oauthError = typeof request.query.error_description === 'string'
      ? request.query.error_description
      : typeof request.query.error === 'string' ? request.query.error : '';
    if (oauthError) {
      response.redirect(`/?tiktok=error&message=${encodeURIComponent(oauthError)}`);
      return;
    }
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!state || !code) {
      response.redirect(`/?tiktok=error&message=${encodeURIComponent('O TikTok não retornou os dados de autorização.')}`);
      return;
    }
    try {
      await completeTikTokAuthorization({ state, code });
      response.redirect('/?tiktok=connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await event('warning', 'tiktok-oauth', 'Não foi possível conectar a conta TikTok', undefined, { message });
      response.redirect(`/?tiktok=error&message=${encodeURIComponent(message)}`);
    }
  });

  app.get('/integrations/youtube/authorize', async (request, response) => {
    try {
      const brand = await brandBySlug(typeof request.query.brandSlug === 'string' ? request.query.brandSlug : 'achadinhos');
      response.redirect(await createYouTubeAuthorization(brand.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.redirect(`/?youtube=error&message=${encodeURIComponent(message)}`);
    }
  });

  app.get(['/integrations/youtube/callback', '/integrations/youtube/callback/'], async (request, response) => {
    const oauthError = typeof request.query.error_description === 'string'
      ? request.query.error_description
      : typeof request.query.error === 'string' ? request.query.error : '';
    if (oauthError) {
      response.redirect(`/?youtube=error&message=${encodeURIComponent(oauthError)}`);
      return;
    }
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!state || !code) {
      response.redirect(`/?youtube=error&message=${encodeURIComponent('O Google não retornou os dados de autorização.')}`);
      return;
    }
    try {
      await completeYouTubeAuthorization({ state, code });
      response.redirect('/?youtube=connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await event('warning', 'youtube-oauth', 'Não foi possível conectar o canal do YouTube', undefined, { message });
      response.redirect(`/?youtube=error&message=${encodeURIComponent(message)}`);
    }
  });

  app.get('/integrations/mercado-livre/authorize-url', async (request, response) => {
    const brand = await brandBySlug(typeof request.query.brandSlug === 'string' ? request.query.brandSlug : 'achadinhos');
    response.json({ authorizationUrl: await createMercadoLivreAuthorization(brand.id), redirectUri: config.MERCADO_LIVRE_REDIRECT_URI });
  });

  app.post('/integrations/mercado-livre/complete', async (request, response) => {
    const callbackUrl = z.string().url().parse(request.body?.callbackUrl);
    const authorization = parseMercadoLivreCallback(callbackUrl);
    const connected = await completeMercadoLivreAuthorization(authorization);
    await event('info', 'mercado-livre-oauth', 'Conta Mercado Livre conectada', connected.brandId, { nickname: connected.nickname });
    response.json({ connected: true, nickname: connected.nickname });
  });

  app.get('/video/models', async (_request, response) => {
    const models = (await listVideoModels()).filter((model) => model.supportsImageToVideo);
    const attempts = await db.query<{ model: string; duration: string | null; aspect_ratio: string | null; resolution: string | null; mode: string | null; status: string; error: string | null; estimated_credit: number | null; used_credit: number | null; updated_at: Date }>(
      `SELECT DISTINCT ON (request->>'model') request->>'model' model,status,error,
              request->>'duration' duration,request->>'aspectRatio' aspect_ratio,request->>'resolution' resolution,request->>'mode' mode,
              COALESCE((response->>'estimatedCredit')::numeric,(response->>'estimated_credit')::numeric) estimated_credit,
              COALESCE((response->>'usedCredit')::numeric,(response->>'used_credit')::numeric) used_credit,updated_at
       FROM operation_ledger WHERE operation_type='snapgen.generate' AND request->>'model' IS NOT NULL
       ORDER BY request->>'model',updated_at DESC`,
    );
    const latestByModel = new Map(attempts.rows.map((attempt) => [attempt.model, attempt]));
    response.json({
      selected: config.SNAPGEN_MODEL,
      duration: config.SNAPGEN_DURATION_SECONDS,
      aspectRatio: config.SNAPGEN_ASPECT_RATIO,
      resolution: config.SNAPGEN_RESOLUTION,
      pricing: { available: true, message: 'O custo estimado e o custo real são informados pelo SnapGen após o envio da solicitação.' },
      models: models.map((model) => ({ ...model, lastAttempt: latestByModel.get(model.id) ?? null })),
    });
  });

  app.get('/video/account', async (_request, response) => {
    response.json(await getSnapGenAccount());
  });

  app.get('/integrations/publishing-limits', async (_request, response) => {
    const brand = await brandBySlug();
    let instagram: Awaited<ReturnType<typeof getInstagramPublishingLimit>> = null;
    let instagramError: string | null = null;
    try { instagram = await getInstagramPublishingLimit(); }
    catch (error) { instagramError = error instanceof Error ? error.message : String(error); }
    const scheduled = await db.query<{ platform: string; count: number; next_attempt_at: Date | null }>(
      `SELECT platform,count(*)::int count,min(next_attempt_at) next_attempt_at
       FROM publication_jobs WHERE brand_id=$1 AND status='scheduled' GROUP BY platform`,
      [brand.id],
    );
    response.json({
      instagram: { observable: true, current: instagram, error: instagramError, policy: 'O total e a janela são lidos da própria API; não são fixados no sistema.' },
      tiktok: { observable: false, policy: 'A plataforma informa o limite somente ao recusar. O teto varia por criador e usa janela móvel de 24 horas.' },
      youtube: { observable: false, policy: 'A cota do projeto é visível no Google Cloud, mas o limite diário do canal só é informado por uploadLimitExceeded.' },
      scheduled: Object.fromEntries(scheduled.rows.map((row) => [row.platform, { count: row.count, nextAttemptAt: row.next_attempt_at }])),
    });
  });

  app.get('/brands', async (_request, response) => {
    const result = await db.query('SELECT id,slug,name,timezone,active,created_at FROM brands ORDER BY name');
    response.json(result.rows);
  });

  app.get('/content/:id', async (request, response) => {
    const result = await db.query(
      `SELECT c.id,c.status,c.hook,c.script,c.caption,c.call_to_action,c.video_url,c.media_kind,c.image_urls,c.qa_score,c.qa_notes,c.scheduled_at,c.created_at,
              p.id product_id,p.title product_title,p.price,p.currency,p.image_url,p.affiliate_url,p.url product_url,p.external_id,p.metadata,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('platform',j.platform,'status',j.status,'externalUrl',j.external_url,'error',j.last_error,'attempts',j.attempts,'nextAttemptAt',j.next_attempt_at,'limitKind',j.limit_kind,'updatedAt',j.updated_at) ORDER BY j.updated_at DESC) FROM publication_jobs j WHERE j.content_id=c.id),'[]'::jsonb) publications,
              (SELECT ol.request->>'model' FROM operation_ledger ol WHERE ol.request->>'contentId'=c.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_model,
              (SELECT COALESCE((ol.response->>'estimatedCredit')::numeric,(ol.response->>'estimated_credit')::numeric) FROM operation_ledger ol WHERE ol.request->>'contentId'=c.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_estimated_credit,
              (SELECT COALESCE((ol.response->>'usedCredit')::numeric,(ol.response->>'used_credit')::numeric) FROM operation_ledger ol WHERE ol.request->>'contentId'=c.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_used_credit
       FROM content_items c
       JOIN products p ON p.id=c.product_id
       WHERE c.id=$1`,
      [request.params.id],
    );
    if (!result.rows[0]) { response.status(404).json({ error: 'Conteúdo não encontrado' }); return; }
    response.json(result.rows[0]);
  });

  app.get(['/dashboard', '/dashboard/:brandSlug'], async (request, response) => {
    const brandSlug = (request.params as Record<string, string | undefined>).brandSlug;
    const brand = await brandBySlug(brandSlug ?? 'achadinhos');
    const [counts, metrics, recent, attention, alerts, ledger] = await Promise.all([
      db.query(`SELECT
        (SELECT count(*) FROM products WHERE brand_id=$1)::int products,
        (SELECT count(*) FROM content_items WHERE brand_id=$1 AND dismissed_at IS NULL)::int content,
        (SELECT count(*) FROM content_items WHERE brand_id=$1 AND status='qa_failed' AND dismissed_at IS NULL)::int rejected,
        (SELECT count(*) FROM publication_jobs WHERE brand_id=$1 AND status='published')::int published`, [brand.id]),
      db.query(`SELECT COALESCE(sum(latest.views),0)::int views,COALESCE(sum(latest.likes),0)::int likes,COALESCE(sum(latest.clicks),0)::int clicks,COALESCE(sum(latest.conversions),0)::int conversions,COALESCE(sum(latest.revenue),0)::numeric revenue
        FROM (SELECT DISTINCT ON (publication_id) views,likes,clicks,conversions,revenue FROM analytics_snapshots WHERE brand_id=$1 ORDER BY publication_id,captured_at DESC) latest`, [brand.id]),
      db.query(`SELECT c.id,p.id product_id,COALESCE(c.status,'product_saved') status,c.hook,c.qa_score,
          COALESCE(c.created_at,p.discovered_at) created_at,COALESCE(c.updated_at,p.discovered_at) updated_at,
          p.title,p.price,p.score,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('platform',j.platform,'status',j.status,'externalUrl',j.external_url,'error',j.last_error,'attempts',j.attempts,'nextAttemptAt',j.next_attempt_at,'limitKind',j.limit_kind,'updatedAt',j.updated_at) ORDER BY j.updated_at DESC) FROM publication_jobs j WHERE j.content_id=c.id),'[]'::jsonb) publications,
          (SELECT ol.error FROM operation_ledger ol WHERE ol.request->>'contentId'=c.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_error,
          (SELECT ol.request->>'model' FROM operation_ledger ol WHERE ol.request->>'contentId'=c.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_model
        FROM products p LEFT JOIN content_items c ON c.product_id=p.id AND c.dismissed_at IS NULL
        WHERE p.brand_id=$1 ORDER BY COALESCE(c.created_at,p.discovered_at) DESC LIMIT 20`, [brand.id]),
      db.query(`SELECT latest.id,p.id product_id,COALESCE(latest.status,'product_saved') status,latest.hook,latest.qa_score,
          COALESCE(latest.created_at,p.discovered_at) created_at,COALESCE(latest.updated_at,p.discovered_at) updated_at,
          p.title,p.price,p.score,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('platform',j.platform,'status',j.status,'externalUrl',j.external_url,'error',j.last_error,'attempts',j.attempts,'nextAttemptAt',j.next_attempt_at,'limitKind',j.limit_kind,'updatedAt',j.updated_at) ORDER BY j.updated_at DESC) FROM publication_jobs j WHERE j.content_id=latest.id),'[]'::jsonb) publications,
          (SELECT ol.error FROM operation_ledger ol WHERE ol.request->>'contentId'=latest.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_error,
          (SELECT ol.request->>'model' FROM operation_ledger ol WHERE ol.request->>'contentId'=latest.id::text ORDER BY ol.created_at DESC LIMIT 1) generation_model
        FROM products p
        LEFT JOIN LATERAL (
          SELECT c.* FROM content_items c
          WHERE c.product_id=p.id AND c.dismissed_at IS NULL
          ORDER BY c.created_at DESC LIMIT 1
        ) latest ON true
        WHERE p.brand_id=$1
          AND (latest.id IS NULL OR latest.status IN ('draft','scripted','generating','video_ready','awaiting_approval','generation_uncertain','qa_failed','failed'))
        ORDER BY COALESCE(latest.created_at,p.discovered_at) DESC LIMIT 10`, [brand.id]),
      db.query(`SELECT id,level,source,message,details,created_at FROM system_events WHERE brand_id=$1 AND level IN ('warning','critical') AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`, [brand.id]),
      db.query(`SELECT status,count(*)::int count FROM operation_ledger WHERE brand_id=$1 GROUP BY status`, [brand.id]),
    ]);
    response.json({ brand, counts: counts.rows[0], metrics: metrics.rows[0], recent: recent.rows, attention: attention.rows, alerts: alerts.rows, operations: ledger.rows, modes: { snapgen: config.SNAPGEN_MODE, publishing: config.PUBLISH_MODE, metrics: config.METRICS_MODE, notifications: config.NOTIFICATION_MODE } });
  });

  app.post('/actions/run-cycle', async (request, response) => {
    const brand = await brandBySlug(String(request.body?.brandSlug ?? 'achadinhos'));
    const jobId = `manual-cycle-${brand.slug}-${Date.now()}`;
    await enqueue(queueNames.product, 'discover-products', { brandSlug: brand.slug }, jobId);
    response.status(202).json({ accepted: true, jobId });
  });

  app.post('/actions/send-report', async (request, response) => {
    const brand = await brandBySlug(String(request.body?.brandSlug ?? 'achadinhos'));
    const kind = request.body?.kind === 'weekly' ? 'weekly-report' : 'daily-report';
    const jobId = `manual-${kind}-${Date.now()}`;
    await enqueue(queueNames.notification, kind, { brandSlug: brand.slug }, jobId);
    response.status(202).json({ accepted: true, jobId });
  });

  app.post('/products/import-official', async (request, response) => {
    const input = officialImportSchema.parse(request.body);
    const video = input.products.some((product) => product.startPipeline) ? await requestedVideoSettings(input) : await requestedVideoSettings({});
    const brand = await brandBySlug(input.brandSlug);
    const imported: Array<{ id: string; affiliateUrl: string; queued: boolean; action: 'created' }> = [];
    const duplicates: Array<{ id: string; affiliateUrl: string; queued: boolean; action: DuplicatePipelineAction }> = [];

    for (const candidate of input.products) {
      const product = normalizeOfficialProduct(candidate);
      const imageUrls = [...new Set([...(product.imageUrls ?? []), ...(product.imageUrl ? [product.imageUrl] : [])])].slice(0, 10);
      const metadata = {
        importSource: 'manual-official-link',
        destinationUrl: product.destinationUrl ?? null,
        channels: product.channels,
        labels: product.labels,
        imageUrls,
        mediaPreference: product.mediaPreference,
        importedAt: new Date().toISOString(),
      };
      const result = await db.query<{ id: string }>(
        `INSERT INTO products (brand_id,provider,external_id,title,url,affiliate_url,image_url,price,score,metadata,status)
         VALUES ($1,'mercado-livre',$2,$3,$4,$5,$6,$7,10,$8,'selected')
         ON CONFLICT DO NOTHING RETURNING id`,
        [brand.id, product.generatedExternalId, product.title, product.destinationUrl ?? product.affiliateUrl, product.affiliateUrl, product.imageUrl ?? null, product.price ?? null, JSON.stringify(metadata)],
      );
      if (!result.rows[0]) {
        const existing = await db.query<{ id: string; brand_id: string; image_url: string | null; content_id: string | null; content_status: string | null }>(
          `SELECT p.id,p.brand_id,p.image_url,c.id content_id,c.status content_status
           FROM products p
           LEFT JOIN LATERAL (
             SELECT id,status FROM content_items WHERE product_id=p.id ORDER BY created_at DESC LIMIT 1
           ) c ON true
           WHERE p.brand_id=$1
             AND (p.affiliate_url=$2 OR (p.provider='mercado-livre' AND p.external_id=$3))
           ORDER BY (p.external_id=$3) DESC
           LIMIT 1`,
          [brand.id, product.affiliateUrl, product.generatedExternalId],
        );
        const existingProduct = existing.rows[0];
        if (!existingProduct) throw new Error('O produto existente não pôde ser localizado após a atualização');
        await db.query(
          `UPDATE products SET title=$2,url=COALESCE($3,url),affiliate_url=$4,image_url=COALESCE($5,image_url),price=COALESCE($6,price),metadata=metadata||$7::jsonb
           WHERE id=$1`,
          [existingProduct.id, product.title, product.destinationUrl ?? null, product.affiliateUrl, product.imageUrl ?? null, product.price ?? null, JSON.stringify(metadata)],
        );
        existingProduct.image_url = product.imageUrl ?? existingProduct.image_url;
        const action = duplicatePipelineAction(product.startPipeline, existingProduct.content_status);
        if (action === 'create') {
          await enqueue(queueNames.content, 'create-copy', { brandId: brand.id, productId: existingProduct.id, ...video }, `content-${existingProduct.id}-${Date.now()}`);
        } else if (action === 'retry') {
          if (!existingProduct.image_url) throw new RequestValidationError('O produto precisa de uma imagem pública antes de tentar gerar o vídeo novamente');
          await retryFailedContent({ id: existingProduct.content_id!, brand_id: existingProduct.brand_id, title: product.title }, video);
        }
        duplicates.push({ id: existingProduct.id, affiliateUrl: product.affiliateUrl, queued: action !== 'none', action });
        continue;
      }
      const productId = result.rows[0].id;
      if (product.startPipeline) await enqueue(queueNames.content, 'create-copy', { brandId: brand.id, productId, ...video }, `content-${productId}`);
      imported.push({ id: productId, affiliateUrl: product.affiliateUrl, queued: product.startPipeline, action: 'created' });
    }
    response.status(201).json({ imported, duplicates, total: input.products.length });
  });

  app.post('/products/resolve-official', async (request, response) => {
    const { urls } = officialResolveSchema.parse(request.body);
    const uniqueUrls = [...new Set(urls)];
    const resolved: Awaited<ReturnType<typeof resolveOfficialAffiliateLink>>[] = [];
    const failed: Array<{ affiliateUrl: string; error: string }> = [];
    const brand = await brandBySlug();
    const mercadoLivre = await getMercadoLivreConnectionStatus(brand.id);
    let mercadoLivreToken: string | null = null;
    if (mercadoLivre.connected) {
      try { mercadoLivreToken = await getMercadoLivreAccessToken(brand.id); }
      catch (error) { await event('warning', 'mercado-livre-api', 'Não foi possível renovar o acesso ao Mercado Livre', brand.id, { message: error instanceof Error ? error.message : String(error) }); }
    }
    for (const affiliateUrl of uniqueUrls) {
      try {
        const product = await resolveOfficialAffiliateLink(affiliateUrl);
        if (mercadoLivreToken) {
          const media = await analyzeMercadoLivreListingMedia(product.externalId, mercadoLivreToken);
          product.listingVideo = media.listingVideo;
          product.imageUrls = media.imageUrls.length ? media.imageUrls : product.imageUrls;
          product.imageUrl = product.imageUrls?.[0] ?? product.imageUrl;
        } else {
          product.listingVideo = { status: 'authorization_required', message: 'Conecte o Mercado Livre para verificar vídeo e fotos do anúncio.' };
        }
        resolved.push(product);
      }
      catch (error) { failed.push({ affiliateUrl, error: error instanceof Error ? error.message : String(error) }); }
    }
    response.json({ resolved, failed, total: uniqueUrls.length });
  });

  app.post('/products/:id/generate', async (request, response) => {
    const video = await requestedVideoSettings(request.body ?? {});
    const result = await db.query<{ id: string; brand_id: string; content_id: string | null; content_status: string | null }>(
      `SELECT p.id,p.brand_id,c.id content_id,c.status content_status
       FROM products p LEFT JOIN content_items c ON c.product_id=p.id WHERE p.id=$1`, [request.params.id],
    );
    const product = result.rows[0];
    if (!product) { response.status(404).json({ error: 'Produto não encontrado' }); return; }
    if (product.content_id) {
      response.status(409).json({ error: 'Este produto já possui conteúdo', contentId: product.content_id, status: product.content_status }); return;
    }
    await enqueue(queueNames.content, 'create-copy', { brandId: product.brand_id, productId: product.id, ...video }, `content-${product.id}`);
    response.status(202).json({ accepted: true, productId: product.id, video });
  });

  app.post('/products/:id/regenerate', async (request, response) => {
    const video = await requestedVideoSettings(request.body ?? {});
    const result = await db.query<{ id: string; brand_id: string; image_url: string | null }>(
      'SELECT id,brand_id,image_url FROM products WHERE id=$1', [request.params.id],
    );
    const product = result.rows[0];
    if (!product) { response.status(404).json({ error: 'Produto não encontrado' }); return; }
    if (!product.image_url) { response.status(409).json({ error: 'O produto precisa de uma imagem pública antes de gerar outro vídeo' }); return; }
    const active = await db.query<{ id: string; status: string }>(
      `SELECT id,status FROM content_items WHERE product_id=$1 AND status IN ('draft','scripted','generating','video_ready') ORDER BY created_at DESC LIMIT 1`, [product.id],
    );
    if (active.rows[0]) {
      response.status(409).json({ error: `Já existe uma versão em andamento (${active.rows[0].status})`, contentId: active.rows[0].id }); return;
    }
    const requestId = Date.now();
    await enqueue(queueNames.content, 'create-copy', { brandId: product.brand_id, productId: product.id, forceNew: true, ...video }, `content-version-${product.id}-${requestId}`);
    response.status(202).json({ accepted: true, productId: product.id, requestId, video });
  });

  app.post('/content/:id/retry-generation', async (request, response) => {
    const video = await requestedVideoSettings(request.body ?? {});
    const result = await db.query<{ id: string; brand_id: string; status: string; image_url: string | null; title: string }>(
      `SELECT c.id,c.brand_id,c.status,p.image_url,p.title FROM content_items c JOIN products p ON p.id=c.product_id WHERE c.id=$1`, [request.params.id],
    );
    const content = result.rows[0];
    if (!content) { response.status(404).json({ error: 'Conteúdo não encontrado' }); return; }
    if (content.status !== 'failed') { response.status(409).json({ error: `A geração não pode ser repetida no status ${content.status}` }); return; }
    if (!content.image_url) { response.status(409).json({ error: 'Adicione uma imagem pública do produto antes de tentar novamente' }); return; }
    const attempt = await retryFailedContent(content, video);
    response.status(202).json({ accepted: true, contentId: content.id, attempt, video });
  });

  app.post('/content/:id/approve', async (request, response) => {
    const content = await db.query<{ id: string; brand_id: string; status: string }>('SELECT id,brand_id,status FROM content_items WHERE id=$1', [request.params.id]);
    const item = content.rows[0];
    if (!item) { response.status(404).json({ error: 'Conteúdo não encontrado' }); return; }
    if (!['awaiting_approval', 'qa_passed'].includes(item.status)) {
      response.status(409).json({ error: `Conteúdo não pode ser aprovado no status ${item.status}` }); return;
    }
    await db.query("UPDATE content_items SET status='qa_passed',updated_at=now() WHERE id=$1", [item.id]);
    await enqueue(queueNames.publishing, 'publish-instagram', { brandId: item.brand_id, contentId: item.id }, `publish-instagram-${item.id}`);
    response.status(202).json({ accepted: true, contentId: item.id });
  });

  app.post('/content/:id/publish', async (request, response) => {
    const requested: unknown[] = Array.isArray(request.body?.platforms) ? request.body.platforms as unknown[] : [];
    const platforms = [...new Set(requested.filter((platform): platform is string => typeof platform === 'string'))];
    if (!platforms.length || platforms.some((platform) => !['instagram', 'tiktok', 'youtube'].includes(platform))) {
      response.status(400).json({ error: 'Informe ao menos uma plataforma válida' }); return;
    }
    const contentResult = await db.query<{ id: string; brand_id: string; status: string }>('SELECT id,brand_id,status FROM content_items WHERE id=$1', [request.params.id]);
    const item = contentResult.rows[0];
    if (!item) { response.status(404).json({ error: 'Conteúdo não encontrado' }); return; }
    if (!['awaiting_approval', 'qa_passed', 'published'].includes(item.status)) {
      response.status(409).json({ error: `Conteúdo não pode ser publicado no status ${item.status}` }); return;
    }
    const youtubeConnection = await getYouTubeConnectionStatus(item.brand_id);
    const configured: Record<string, boolean> = {
      instagram: Boolean(config.META_ACCESS_TOKEN && config.INSTAGRAM_ACCOUNT_ID),
      tiktok: await hasTikTokConnection(item.brand_id),
      youtube: youtubeConnection.connected,
    };
    const unavailable = platforms.filter((platform) => !configured[platform]);
    if (unavailable.length) {
      response.status(409).json({ error: `Conecte primeiro: ${unavailable.join(', ')}`, unavailable }); return;
    }
    const tiktokSettings = platforms.includes('tiktok') ? tiktokPublishSettingsSchema.parse(request.body?.tiktok) : null;
    const existing = await db.query<{ platform: string; status: string }>(
      'SELECT platform,status FROM publication_jobs WHERE content_id=$1 AND platform=ANY($2::text[])', [item.id, platforms],
    );
    const existingByPlatform = new Map(existing.rows.map((row) => [row.platform, row.status]));
    const unsafe = platforms.filter((platform) => ['pending', 'publishing', 'scheduled', 'uncertain'].includes(existingByPlatform.get(platform) ?? ''));
    if (unsafe.length) {
      response.status(409).json({ error: `Publicação já está em andamento ou incerta em: ${unsafe.join(', ')}`, unsafe }); return;
    }
    const queued: string[] = [];
    const alreadyPublished: string[] = [];
    for (const platform of platforms) {
      if (existingByPlatform.get(platform) === 'published') { alreadyPublished.push(platform); continue; }
      const retrying = existingByPlatform.get(platform) === 'failed';
      const publicationSettings = platform === 'tiktok' ? tiktokSettings : {};
      await db.query(
        `INSERT INTO publication_jobs (brand_id,content_id,platform,status,settings)
         VALUES ($1,$2,$3,'pending',$4)
         ON CONFLICT (content_id,platform) DO UPDATE
         SET status='pending',settings=excluded.settings,last_error=NULL,updated_at=now()`,
        [item.brand_id, item.id, platform, JSON.stringify(publicationSettings)],
      );
      const jobId = retrying ? `publish-${platform}-${item.id}-retry-${Date.now()}` : `publish-${platform}-${item.id}`;
      try {
        await enqueue(queueNames.publishing, `publish-${platform}`, { brandId: item.brand_id, contentId: item.id, platform, settings: publicationSettings }, jobId);
      } catch (error) {
        await db.query("UPDATE publication_jobs SET status='failed',last_error=$3,updated_at=now() WHERE content_id=$1 AND platform=$2", [item.id, platform, error instanceof Error ? error.message : String(error)]);
        throw error;
      }
      queued.push(platform);
    }
    if (queued.length && item.status === 'awaiting_approval') {
      await db.query("UPDATE content_items SET status='qa_passed',updated_at=now() WHERE id=$1", [item.id]);
    }
    response.status(202).json({ accepted: true, contentId: item.id, queued, alreadyPublished });
  });

  app.post('/content/:id/reject', async (request, response) => {
    const content = await db.query<{ id: string; brand_id: string; status: string; qa_notes: unknown }>(
      'SELECT id,brand_id,status,qa_notes FROM content_items WHERE id=$1', [request.params.id],
    );
    const item = content.rows[0];
    if (!item) { response.status(404).json({ error: 'Conteúdo não encontrado' }); return; }
    if (!['awaiting_approval', 'qa_passed'].includes(item.status)) {
      response.status(409).json({ error: `Conteúdo não pode ser reprovado no status ${item.status}` }); return;
    }
    const reason = typeof request.body?.reason === 'string' && request.body.reason.trim()
      ? request.body.reason.trim().slice(0, 500)
      : 'O vídeo não representa fielmente a quantidade e os tipos de peças do produto.';
    const previousNotes = Array.isArray(item.qa_notes) ? item.qa_notes.filter((note): note is string => typeof note === 'string') : [];
    await db.query("UPDATE content_items SET status='qa_failed',qa_score=0,qa_notes=$2,updated_at=now() WHERE id=$1", [item.id, JSON.stringify([...previousNotes, reason])]);
    await event('warning', 'human-review', 'Conteúdo reprovado na revisão visual', item.brand_id, { contentId: item.id, reason });
    response.json({ rejected: true, contentId: item.id, reason });
  });

  app.post('/content/:id/dismiss', async (request, response) => {
    const result = await db.query(
      `UPDATE content_items SET dismissed_at=now(),updated_at=now()
       WHERE id=$1 AND dismissed_at IS NULL
         AND status IN ('qa_failed','failed','generation_uncertain','awaiting_approval')
       RETURNING id`,
      [request.params.id],
    );
    if (!result.rowCount) {
      response.status(409).json({ error: 'Este item não pode ser dispensado ou já foi removido das pendências.' });
      return;
    }
    response.json({ dismissed: true, contentId: request.params.id });
  });

  app.post('/events/:id/resolve', async (request, response) => {
    const result = await db.query('UPDATE system_events SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL RETURNING id', [request.params.id]);
    response.status(result.rowCount ? 200 : 404).json({ resolved: Boolean(result.rowCount) });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    console.error(error);
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => {
        const productIndex = issue.path[0] === 'products' && typeof issue.path[1] === 'number' ? issue.path[1] + 1 : null;
        const field = issue.path.at(-1);
        const location = productIndex ? `Produto ${productIndex}${typeof field === 'string' ? ` (${field})` : ''}` : issue.path.join('.');
        return location ? `${location}: ${issue.message}` : issue.message;
      });
      response.status(400).json({ error: details.join(' | ') || 'Dados inválidos', issues: error.issues });
      return;
    }
    if (error instanceof RequestValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' });
  });
  return app;
}

export function startApi(): ReturnType<express.Express['listen']> {
  const app = createApp();
  return app.listen(config.PORT, '0.0.0.0', () => console.log(JSON.stringify({ message: 'api_started', port: config.PORT })));
}
