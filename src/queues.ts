import { Queue, type ConnectionOptions } from 'bullmq';
import { config } from './config.js';

export const queueNames = {
  product: 'product-discovery',
  content: 'content-generation',
  snapgen: 'snapgen-generation',
  qa: 'quality-assurance',
  publishing: 'publishing',
  analytics: 'analytics',
  notification: 'notifications',
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export function bullConnection(): ConnectionOptions {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
  };
}

export function queue(name: QueueName): Queue {
  return new Queue(name, { connection: bullConnection(), defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 500, removeOnFail: 1000 } });
}

export async function enqueue(name: QueueName, jobName: string, data: Record<string, unknown>, jobId?: string, delay = 0): Promise<void> {
  const q = queue(name);
  try {
    await q.add(jobName, data, { jobId, delay });
  } finally {
    await q.close();
  }
}
