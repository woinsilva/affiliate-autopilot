import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from './config.js';
import { brandBySlug, db, event } from './db.js';
import { completeOperation, markOperation, reserveOperation } from './ledger.js';
import { bullConnection, enqueue, queueNames, type QueueName } from './queues.js';
import { createCopy, DefinitivePublishError, discoverProducts, generateVideo, mockMetrics, pollVideo, PublicationRateLimitError, publishInstagram, publishTikTok, publishYouTube, sendEmail, type TikTokPublishSettings } from './providers.js';
import { renderProductSlideshow } from './media.js';

type Payload = Record<string, unknown>;

function jobVideoSettings(data: Payload): { model: string; duration: number; aspectRatio: string; resolution: string; mode: string } {
  return {
    model: typeof data.model === 'string' ? data.model : config.SNAPGEN_MODEL,
    duration: typeof data.duration === 'number' ? data.duration : config.SNAPGEN_DURATION_SECONDS,
    aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : config.SNAPGEN_ASPECT_RATIO,
    resolution: typeof data.resolution === 'string' ? data.resolution : config.SNAPGEN_RESOLUTION,
    mode: typeof data.mode === 'string' ? data.mode : '',
  };
}

async function productProcessor(job: Job<Payload>): Promise<{ selected: number }> {
  const brand = await brandBySlug(String(job.data.brandSlug ?? 'achadinhos'));
  const products = await discoverProducts();
  let selected = 0;
  for (const product of products.filter((candidate) => candidate.score >= 8)) {
    const result = await db.query<{ id: string }>(
      `INSERT INTO products (brand_id,provider,external_id,title,url,affiliate_url,image_url,price,score,metadata,status)
       VALUES ($1,'mercado-livre',$2,$3,$4,$5,$6,$7,$8,$9,'selected')
       ON CONFLICT (brand_id,provider,external_id) DO UPDATE SET title=excluded.title, price=excluded.price, score=excluded.score, metadata=excluded.metadata
       RETURNING id`,
      [brand.id, product.externalId, product.title, product.url, product.affiliateUrl, product.imageUrl ?? null, product.price, product.score, JSON.stringify(product.metadata)],
    );
    const productId = result.rows[0]!.id;
    await enqueue(queueNames.content, 'create-copy', { brandId: brand.id, productId }, `content-${productId}`);
    selected += 1;
  }
  await event('info', 'product-worker', `${selected} produtos selecionados`, brand.id);
  return { selected };
}

async function contentProcessor(job: Job<Payload>): Promise<{ contentId: string }> {
  const productId = String(job.data.productId);
  const result = await db.query<{ id: string; brand_id: string; title: string; affiliate_url: string; image_url: string | null; metadata: Record<string, unknown> }>(
    'SELECT id,brand_id,title,affiliate_url,image_url,metadata FROM products WHERE id=$1', [productId],
  );
  const product = result.rows[0];
  if (!product) throw new UnrecoverableError(`Product ${productId} not found`);
  if (job.data.forceNew !== true) {
    const existing = await db.query<{ id: string }>('SELECT id FROM content_items WHERE product_id=$1 ORDER BY created_at DESC LIMIT 1', [product.id]);
    if (existing.rows[0]) return { contentId: existing.rows[0].id };
  }
  const copy = createCopy(product.title, product.affiliate_url);
  const imageUrls = Array.isArray(product.metadata.imageUrls)
    ? product.metadata.imageUrls.filter((url): url is string => typeof url === 'string' && url.startsWith('https://http2.mlstatic.com/')).slice(0, 10)
    : [];
  const mediaPreference = product.metadata.mediaPreference;
  const useSlideshow = mediaPreference !== 'ai' && imageUrls.length >= 2;
  const content = await db.query<{ id: string }>(
    `INSERT INTO content_items (brand_id,product_id,status,hook,script,caption,call_to_action,media_kind,image_urls)
     VALUES ($1,$2,'scripted',$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [product.brand_id, product.id, copy.hook, copy.script, copy.caption, copy.cta, useSlideshow ? 'slideshow' : 'ai_video', JSON.stringify(imageUrls)],
  );
  const contentId = content.rows[0]!.id;
  if (useSlideshow) {
    await enqueue(queueNames.content, 'render-slideshow', { brandId: product.brand_id, contentId, imageUrls, imageUrl: product.image_url, mediaPreference, ...jobVideoSettings(job.data) }, `slideshow-${contentId}`);
  } else {
    await enqueue(queueNames.snapgen, 'generate-video', { brandId: product.brand_id, contentId, ...jobVideoSettings(job.data) }, `snapgen-${contentId}`);
  }
  return { contentId };
}

async function slideshowProcessor(job: Job<Payload>): Promise<{ contentId: string; status: string }> {
  const contentId = String(job.data.contentId);
  const imageUrls = Array.isArray(job.data.imageUrls) ? job.data.imageUrls.filter((value): value is string => typeof value === 'string') : [];
  await db.query("UPDATE content_items SET status='generating',updated_at=now() WHERE id=$1 AND status='scripted'", [contentId]);
  try {
    const videoUrl = await renderProductSlideshow(contentId, imageUrls);
    await finishVideo(contentId, videoUrl);
    return { contentId, status: 'rendered' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await event('warning', 'media-worker', 'Não foi possível montar o vídeo com fotos do anúncio', String(job.data.brandId), { contentId, message });
    await db.query("UPDATE content_items SET status='failed',updated_at=now() WHERE id=$1", [contentId]);
    return { contentId, status: 'failed' };
  }
}

async function snapgenProcessor(job: Job<Payload>): Promise<{ contentId: string; status: string }> {
  const contentId = String(job.data.contentId);
  const contentResult = await db.query<{ brand_id: string; title: string; script: string; image_url: string | null }>(
    `SELECT c.brand_id,p.title,c.script,p.image_url FROM content_items c JOIN products p ON p.id=c.product_id WHERE c.id=$1`, [contentId],
  );
  const content = contentResult.rows[0];
  if (!content) throw new UnrecoverableError(`Content ${contentId} not found`);
  const video = jobVideoSettings(job.data);
  const key = typeof job.data.operationKey === 'string' ? job.data.operationKey : `snapgen:generate:${contentId}`;
  const reservation = await reserveOperation({ brandId: content.brand_id, type: 'snapgen.generate', key, request: { contentId, title: content.title, ...video } });

  if (!reservation.acquired) {
    if (reservation.row.status === 'succeeded') {
      const videoUrl = reservation.row.response?.videoUrl;
      if (typeof videoUrl === 'string') await finishVideo(contentId, videoUrl);
      return { contentId, status: 'already-completed' };
    }
    if (reservation.row.external_id) {
      const polled = await pollVideo(reservation.row.external_id);
      if (polled.status === 'completed' && polled.videoUrl) {
        await completeOperation(reservation.row.id, polled.externalId, { ...polled.raw, videoUrl: polled.videoUrl });
        await finishVideo(contentId, polled.videoUrl);
        return { contentId, status: 'completed' };
      }
      if (polled.status === 'failed') {
        const reason = polled.error ?? 'O provedor não informou o motivo';
        await db.query('UPDATE operation_ledger SET response=$2,updated_at=now() WHERE id=$1', [reservation.row.id, JSON.stringify(polled.raw)]);
        await markOperation(reservation.row.id, 'failed', reason);
        await db.query("UPDATE content_items SET status='failed',updated_at=now() WHERE id=$1", [contentId]);
        await event('warning', 'snapgen-worker', 'A geração de vídeo falhou', content.brand_id, { contentId, reason });
        return { contentId, status: 'failed' };
      }
      await enqueue(queueNames.snapgen, 'poll-video', { brandId: content.brand_id, contentId, operationKey: key, ...video }, `poll-${contentId}-${Date.now()}`, config.SNAPGEN_POLL_SECONDS * 1_000);
      return { contentId, status: 'processing' };
    }
    await db.query("UPDATE content_items SET status='generation_uncertain',updated_at=now() WHERE id=$1", [contentId]);
    await event('critical', 'snapgen-worker', 'Geração SnapGen incerta; repetição automática bloqueada para evitar cobrança duplicada', content.brand_id, { contentId, operationId: reservation.row.id });
    return { contentId, status: 'blocked-uncertain' };
  }

  await db.query("UPDATE content_items SET status='generating',updated_at=now() WHERE id=$1", [contentId]);
  try {
    const generated = await generateVideo({ title: content.title, script: content.script, imageUrl: content.image_url ?? undefined, idempotencyKey: typeof job.data.providerIdempotencyKey === 'string' ? job.data.providerIdempotencyKey : contentId, ...video });
    if (generated.status === 'completed' && generated.videoUrl) {
      await completeOperation(reservation.row.id, generated.externalId, { ...generated.raw, videoUrl: generated.videoUrl });
      await finishVideo(contentId, generated.videoUrl);
      return { contentId, status: 'completed' };
    }
    if (generated.status === 'failed') {
      const reason = generated.error ?? 'O provedor não informou o motivo';
      await db.query('UPDATE operation_ledger SET response=$2,updated_at=now() WHERE id=$1', [reservation.row.id, JSON.stringify(generated.raw)]);
      await markOperation(reservation.row.id, 'failed', reason);
      await db.query("UPDATE content_items SET status='failed',updated_at=now() WHERE id=$1", [contentId]);
      await event('warning', 'snapgen-worker', 'A geração de vídeo falhou', content.brand_id, { contentId, reason });
      return { contentId, status: 'failed' };
    }
    await db.query('UPDATE operation_ledger SET external_id=$2,response=$3,updated_at=now() WHERE id=$1', [reservation.row.id, generated.externalId, JSON.stringify(generated.raw)]);
    await enqueue(queueNames.snapgen, 'poll-video', { brandId: content.brand_id, contentId, operationKey: key, ...video }, `poll-${contentId}-${Date.now()}`, config.SNAPGEN_POLL_SECONDS * 1_000);
    return { contentId, status: 'processing' };
  } catch (error) {
    await markOperation(reservation.row.id, 'uncertain', error);
    await db.query("UPDATE content_items SET status='generation_uncertain',updated_at=now() WHERE id=$1", [contentId]);
    await event('critical', 'snapgen-worker', 'Falha incerta no SnapGen; repetição automática bloqueada', content.brand_id, { contentId, error: error instanceof Error ? error.message : String(error) });
    throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
  }
}

async function finishVideo(contentId: string, videoUrl: string): Promise<void> {
  await db.query("UPDATE content_items SET status='video_ready',video_url=$2,updated_at=now() WHERE id=$1", [contentId, videoUrl]);
  await enqueue(queueNames.qa, 'review-video', { contentId }, `qa-${contentId}`);
}

async function qaProcessor(job: Job<Payload>): Promise<{ passed: boolean; score: number }> {
  const contentId = String(job.data.contentId);
  const result = await db.query<{ brand_id: string; hook: string | null; script: string | null; caption: string | null; video_url: string | null }>(
    'SELECT brand_id,hook,script,caption,video_url FROM content_items WHERE id=$1', [contentId],
  );
  const content = result.rows[0];
  if (!content) throw new UnrecoverableError(`Content ${contentId} not found`);
  const notes: string[] = [];
  if (!content.hook || content.hook.length < 15) notes.push('Hook muito curto');
  if (!content.script || content.script.length < 40) notes.push('Roteiro incompleto');
  if (!content.caption?.toLowerCase().includes('afiliad')) notes.push('Divulgação de afiliado ausente');
  if (!content.video_url) notes.push('Vídeo ausente');
  const score = Math.max(0, 100 - notes.length * 25);
  const passed = score >= 75;
  const passedStatus = config.AUTO_PUBLISH_AFTER_QA ? 'qa_passed' : 'awaiting_approval';
  await db.query('UPDATE content_items SET status=$2,qa_score=$3,qa_notes=$4,updated_at=now() WHERE id=$1', [contentId, passed ? passedStatus : 'qa_failed', score, JSON.stringify(notes)]);
  if (passed) {
    if (config.AUTO_PUBLISH_AFTER_QA) await enqueue(queueNames.publishing, 'publish-instagram', { brandId: content.brand_id, contentId }, `publish-instagram-${contentId}`);
  } else {
    await event('warning', 'qa-worker', 'Conteúdo reprovado no QA', content.brand_id, { contentId, notes });
  }
  return { passed, score };
}

async function recoverScheduledPublications(): Promise<number> {
  const due = await db.query<{ id: string; brand_id: string; content_id: string; platform: string; settings: Record<string, unknown>; next_attempt_at: Date }>(
    `SELECT id,brand_id,content_id,platform,settings,next_attempt_at
     FROM publication_jobs WHERE status='scheduled' AND next_attempt_at <= now()
     ORDER BY next_attempt_at LIMIT 100`,
  );
  for (const publication of due.rows) {
    await enqueue(
      queueNames.publishing,
      `publish-${publication.platform}`,
      { brandId: publication.brand_id, contentId: publication.content_id, platform: publication.platform, settings: publication.settings },
      `scheduled-${publication.id}-${publication.next_attempt_at.getTime()}`,
    );
  }
  return due.rowCount ?? 0;
}

async function publishingProcessor(job: Job<Payload>): Promise<{ status: string; publicationId?: string; recovered?: number; nextAttemptAt?: string }> {
  if (job.name === 'recover-scheduled-publications') {
    const recovered = await recoverScheduledPublications();
    return { status: 'recovered', recovered };
  }
  const contentId = String(job.data.contentId);
  const platform = String(job.data.platform ?? 'instagram');
  if (!['instagram', 'tiktok', 'youtube'].includes(platform)) throw new UnrecoverableError(`Unsupported publishing platform ${platform}`);
  const result = await db.query<{ brand_id: string; caption: string; video_url: string; title: string; media_kind: string; image_urls: string[] }>(
    'SELECT c.brand_id,c.caption,c.video_url,c.media_kind,c.image_urls,p.title FROM content_items c JOIN products p ON p.id=c.product_id WHERE c.id=$1', [contentId],
  );
  const content = result.rows[0];
  if (!content?.video_url) throw new UnrecoverableError(`Publishable content ${contentId} not found`);
  const settings = job.data.settings && typeof job.data.settings === 'object' ? job.data.settings as Record<string, unknown> : {};
  const publication = await db.query<{ id: string; attempts: number }>(
    `INSERT INTO publication_jobs (brand_id,content_id,platform,status,settings,attempts) VALUES ($1,$2,$3,'publishing',$4,1)
     ON CONFLICT (content_id,platform) DO UPDATE SET status='publishing',settings=excluded.settings,last_error=NULL,next_attempt_at=NULL,limit_kind=NULL,attempts=publication_jobs.attempts+1,updated_at=now()
     RETURNING id,attempts`, [content.brand_id, contentId, platform, JSON.stringify(settings)],
  );
  const publicationId = publication.rows[0]!.id;
  const reservation = await reserveOperation({ brandId: content.brand_id, type: `${platform}.publish`, key: `${platform}:publish:${contentId}`, request: { contentId, publicationId, platform, settings } });
  if (!reservation.acquired) {
    if (reservation.row.status === 'succeeded') return { status: 'already-published', publicationId };
    await db.query("UPDATE publication_jobs SET status='uncertain',last_error='Operação externa incerta; revisão manual necessária',updated_at=now() WHERE id=$1", [publicationId]);
    await event('critical', 'publishing-worker', 'Publicação incerta; duplicação automática bloqueada', content.brand_id, { contentId, publicationId });
    return { status: 'blocked-uncertain', publicationId };
  }
  try {
    const published = platform === 'instagram'
      ? await publishInstagram({ videoUrl: content.video_url, caption: content.caption, imageUrls: content.media_kind === 'slideshow' ? content.image_urls : [] })
      : platform === 'tiktok'
        ? await publishTikTok({ brandId: content.brand_id, videoUrl: content.video_url, caption: content.caption, settings: settings as TikTokPublishSettings })
        : await publishYouTube({ brandId: content.brand_id, videoUrl: content.video_url, title: content.title, description: content.caption });
    await completeOperation(reservation.row.id, published.externalId, published.raw);
    await db.query("UPDATE publication_jobs SET status='published',external_id=$2,external_url=$3,published_at=now(),updated_at=now() WHERE id=$1", [publicationId, published.externalId, published.url]);
    await db.query("UPDATE content_items SET status='published',updated_at=now() WHERE id=$1", [contentId]);
    await enqueue(queueNames.analytics, 'collect-publication', { brandId: content.brand_id, publicationId }, `metrics-${publicationId}-${Date.now()}`);
    return { status: 'published', publicationId };
  } catch (error) {
    if (error instanceof PublicationRateLimitError) {
      await markOperation(reservation.row.id, 'failed', error);
      await db.query(
        `UPDATE publication_jobs SET status='scheduled',last_error=$2,next_attempt_at=$3,limit_kind=$4,updated_at=now() WHERE id=$1`,
        [publicationId, error.message, error.retryAt, error.limitKind],
      );
      await enqueue(
        queueNames.publishing,
        `publish-${platform}`,
        { brandId: content.brand_id, contentId, platform, settings },
        `publish-${platform}-${contentId}-limit-${error.retryAt.getTime()}`,
        Math.max(1_000, error.retryAt.getTime() - Date.now()),
      );
      await event('info', 'publishing-worker', 'Publicação agendada automaticamente após limite da plataforma', content.brand_id, { contentId, publicationId, platform, nextAttemptAt: error.retryAt.toISOString(), limitKind: error.limitKind });
      return { status: 'scheduled', publicationId, nextAttemptAt: error.retryAt.toISOString() };
    }
    const definitive = error instanceof DefinitivePublishError;
    const failureStatus = definitive ? 'failed' : 'uncertain';
    await markOperation(reservation.row.id, failureStatus, error);
    await db.query('UPDATE publication_jobs SET status=$2,last_error=$3,updated_at=now() WHERE id=$1', [publicationId, failureStatus, error instanceof Error ? error.message : String(error)]);
    await event(definitive ? 'warning' : 'critical', 'publishing-worker', definitive ? 'Publicação recusada antes do envio' : 'Falha incerta ao publicar; repetição automática bloqueada', content.brand_id, { contentId, publicationId });
    throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
  }
}

async function analyticsProcessor(job: Job<Payload>): Promise<{ captured: number }> {
  if (config.METRICS_MODE === 'disabled') return { captured: 0 };
  const brandId = typeof job.data.brandId === 'string' ? job.data.brandId : (await brandBySlug()).id;
  const publications = job.data.publicationId
    ? await db.query<{ id: string; external_id: string }>('SELECT id,external_id FROM publication_jobs WHERE id=$1 AND status=\'published\'', [String(job.data.publicationId)])
    : await db.query<{ id: string; external_id: string }>('SELECT id,external_id FROM publication_jobs WHERE brand_id=$1 AND status=\'published\'', [brandId]);
  for (const publication of publications.rows) {
    if (config.METRICS_MODE !== 'mock') throw new Error('Live analytics provider is not enabled in M1');
    const metrics = mockMetrics(publication.external_id);
    await db.query(
      `INSERT INTO analytics_snapshots (brand_id,publication_id,views,likes,comments,shares,clicks,conversions,revenue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [brandId, publication.id, metrics.views, metrics.likes, metrics.comments, metrics.shares, metrics.clicks, metrics.conversions, metrics.revenue],
    );
  }
  return { captured: publications.rowCount ?? 0 };
}

async function notificationProcessor(job: Job<Payload>): Promise<{ sent: boolean }> {
  const brand = await brandBySlug(String(job.data.brandSlug ?? 'achadinhos'));
  const kind = String(job.name);
  if (kind === 'critical-alert') {
    const subject = `${brand.name} — Alerta crítico: ${String(job.data.source ?? 'sistema')}`;
    const html = `<h1>⚠️ Atenção necessária</h1><p>${String(job.data.message ?? 'O sistema registrou um alerta crítico.')}</p><p><strong>Origem:</strong> ${String(job.data.source ?? 'sistema')}</p><p><strong>Evento:</strong> ${String(job.data.eventId ?? '')}</p><p>Consulte o dashboard antes de repetir qualquer operação externa.</p>`;
    const sent = await sendEmail({ subject, html });
    await db.query('INSERT INTO notification_log (brand_id,kind,recipient,status,subject,provider_id) VALUES ($1,$2,$3,$4,$5,$6)', [brand.id, kind, config.EMAIL_TO || null, 'sent', subject, sent.id]);
    return { sent: true };
  }
  const days = kind === 'weekly-report' ? 7 : 1;
  const summary = await db.query(
    `SELECT
      (SELECT count(*) FROM products WHERE brand_id=$1 AND discovered_at >= now()-($2 || ' days')::interval)::int products,
      (SELECT count(*) FROM content_items WHERE brand_id=$1 AND created_at >= now()-($2 || ' days')::interval)::int content,
      (SELECT count(*) FROM publication_jobs WHERE brand_id=$1 AND status='published' AND published_at >= now()-($2 || ' days')::interval)::int published,
      COALESCE((SELECT sum(a.views) FROM analytics_snapshots a WHERE a.brand_id=$1 AND a.captured_at >= now()-($2 || ' days')::interval),0)::int views,
      COALESCE((SELECT sum(a.clicks) FROM analytics_snapshots a WHERE a.brand_id=$1 AND a.captured_at >= now()-($2 || ' days')::interval),0)::int clicks,
      COALESCE((SELECT sum(a.conversions) FROM analytics_snapshots a WHERE a.brand_id=$1 AND a.captured_at >= now()-($2 || ' days')::interval),0)::int conversions,
      COALESCE((SELECT sum(a.revenue) FROM analytics_snapshots a WHERE a.brand_id=$1 AND a.captured_at >= now()-($2 || ' days')::interval),0)::numeric revenue,
      (SELECT count(*) FROM system_events WHERE brand_id=$1 AND level='critical' AND resolved_at IS NULL)::int critical`,
    [brand.id, days],
  );
  const row = summary.rows[0];
  const period = days === 7 ? 'semanal' : 'diário';
  const subject = `${brand.name} — Relatório ${period}`;
  const html = `<h1>${subject}</h1><p>Produtos selecionados: <strong>${row.products}</strong></p><p>Conteúdos: <strong>${row.content}</strong></p><p>Publicações: <strong>${row.published}</strong></p><p>Views: <strong>${row.views}</strong> · Cliques: <strong>${row.clicks}</strong> · Vendas: <strong>${row.conversions}</strong></p><p>Receita atribuída: <strong>R$ ${Number(row.revenue).toFixed(2)}</strong></p><p>Alertas críticos abertos: <strong>${row.critical}</strong></p><hr><small>Affiliate Autopilot · ${new Date().toLocaleString('pt-BR', { timeZone: brand.timezone })}</small>`;
  const sent = await sendEmail({ subject, html });
  await db.query('INSERT INTO notification_log (brand_id,kind,recipient,status,subject,provider_id) VALUES ($1,$2,$3,$4,$5,$6)', [brand.id, kind, config.EMAIL_TO || null, 'sent', subject, sent.id]);
  return { sent: true };
}

const processors: Partial<Record<QueueName, (job: Job<Payload>) => Promise<unknown>>> = {
  [queueNames.product]: productProcessor,
  [queueNames.content]: (job) => job.name === 'render-slideshow' ? slideshowProcessor(job) : contentProcessor(job),
  [queueNames.snapgen]: snapgenProcessor,
  [queueNames.qa]: qaProcessor,
  [queueNames.publishing]: publishingProcessor,
  [queueNames.analytics]: analyticsProcessor,
  [queueNames.notification]: notificationProcessor,
};

export function startWorker(name: QueueName): Worker {
  const processor = processors[name];
  if (!processor) throw new Error(`No processor for ${name}`);
  const worker = new Worker(name, processor, { connection: bullConnection(), concurrency: name === queueNames.snapgen || name === queueNames.publishing ? 1 : 4 });
  worker.on('completed', (job) => console.log(JSON.stringify({ message: 'job_completed', queue: name, jobId: job.id })));
  worker.on('failed', (job, error) => console.error(JSON.stringify({ message: 'job_failed', queue: name, jobId: job?.id, error: error.message })));
  return worker;
}
