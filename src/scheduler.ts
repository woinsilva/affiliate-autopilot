import { config, validateLiveConfiguration } from './config.js';
import { brandBySlug, event } from './db.js';
import { queue, queueNames } from './queues.js';

export async function startScheduler(): Promise<() => Promise<void>> {
  const brand = await brandBySlug();
  const issues = validateLiveConfiguration();
  for (const issue of issues) await event('critical', 'configuration', issue, brand.id);

  const product = queue(queueNames.product);
  const analytics = queue(queueNames.analytics);
  const notifications = queue(queueNames.notification);
  const publishing = queue(queueNames.publishing);

  if (config.PRODUCT_PROVIDER === 'manual') {
    await product.removeJobScheduler('achadinhos-product-discovery');
  } else {
    await product.upsertJobScheduler(
      'achadinhos-product-discovery',
      { pattern: config.DISCOVERY_CRON, tz: config.TIMEZONE },
      { name: 'discover-products', data: { brandSlug: brand.slug } },
    );
  }
  await analytics.upsertJobScheduler(
    'achadinhos-analytics',
    { pattern: config.ANALYTICS_CRON, tz: config.TIMEZONE },
    { name: 'collect-brand', data: { brandId: brand.id } },
  );
  await notifications.upsertJobScheduler(
    'achadinhos-daily-report',
    { pattern: config.DAILY_REPORT_CRON, tz: config.TIMEZONE },
    { name: 'daily-report', data: { brandSlug: brand.slug } },
  );
  await publishing.upsertJobScheduler(
    'recover-scheduled-publications',
    { pattern: '*/15 * * * *', tz: config.TIMEZONE },
    { name: 'recover-scheduled-publications', data: {} },
  );
  await notifications.upsertJobScheduler(
    'achadinhos-weekly-report',
    { pattern: config.WEEKLY_REPORT_CRON, tz: config.TIMEZONE },
    { name: 'weekly-report', data: { brandSlug: brand.slug } },
  );

  if (config.AUTO_SEED_DEMO && config.PRODUCT_PROVIDER !== 'manual') {
    await product.add('discover-products', { brandSlug: brand.slug }, { jobId: 'achadinhos-first-run' });
  }
  await event('info', 'scheduler', 'Agendamentos carregados', brand.id, { discovery: config.PRODUCT_PROVIDER === 'manual' ? 'manual' : config.DISCOVERY_CRON, analytics: config.ANALYTICS_CRON });
  console.log(JSON.stringify({ message: 'scheduler_started', brand: brand.slug, safeModes: { snapgen: config.SNAPGEN_MODE, publishing: config.PUBLISH_MODE, notifications: config.NOTIFICATION_MODE } }));

  return async () => { await Promise.all([product.close(), analytics.close(), notifications.close(), publishing.close()]); };
}
