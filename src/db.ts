import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const db = new Pool({ connectionString: config.DATABASE_URL, max: 12 });

export async function closeDb(): Promise<void> {
  await db.end();
}

export async function brandBySlug(slug = 'achadinhos'): Promise<{ id: string; slug: string; name: string; timezone: string }> {
  const result = await db.query('SELECT id, slug, name, timezone FROM brands WHERE slug = $1 AND active = true', [slug]);
  if (!result.rows[0]) throw new Error(`Brand ${slug} not found`);
  return result.rows[0];
}

export async function event(level: 'info' | 'warning' | 'critical', source: string, message: string, brandId?: string, details: unknown = {}): Promise<void> {
  const inserted = await db.query<{ id: string }>(
    'INSERT INTO system_events (brand_id, level, source, message, details) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [brandId ?? null, level, source, message, JSON.stringify(details)],
  );
  if (level === 'critical') {
    const { enqueue, queueNames } = await import('./queues.js');
    const eventId = inserted.rows[0]!.id;
    await enqueue(queueNames.notification, 'critical-alert', { brandId, eventId, source, message, details }, `critical-alert-${eventId}`);
  }
}
