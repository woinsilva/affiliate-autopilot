import 'dotenv/config';
import { z } from 'zod';

const boolFalse = z.string().default('false').transform((value) => value.toLowerCase() === 'true');
const boolTrue = z.string().default('true').transform((value) => value.toLowerCase() === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROCESS_ROLE: z.string().default('api'),
  DATABASE_URL: z.string().default('postgresql://affiliate:affiliate@localhost:5432/affiliate_autopilot'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(3000),
  PRODUCT_PROVIDER: z.enum(['manual', 'mock', 'mercado-livre']).default('manual'),
  CONTENT_PROVIDER: z.enum(['template', 'mock']).default('template'),
  SNAPGEN_MODE: z.enum(['mock', 'live']).default('mock'),
  PUBLISH_MODE: z.enum(['mock', 'live']).default('mock'),
  METRICS_MODE: z.enum(['disabled', 'mock', 'live']).default('disabled'),
  NOTIFICATION_MODE: z.enum(['log', 'resend']).default('log'),
  ALLOW_PAID_OPERATIONS: boolFalse,
  ALLOW_REAL_PUBLISHING: boolFalse,
  AUTO_SEED_DEMO: boolFalse,
  AUTO_PUBLISH_AFTER_QA: boolFalse,
  SNAPGEN_BASE_URL: z.string().url().default('http://host.docker.internal:3001'),
  SNAPGEN_API_KEY: z.string().default(''),
  SNAPGEN_POLL_SECONDS: z.coerce.number().int().positive().default(10),
  SNAPGEN_MODEL: z.string().min(1).default('kling-video-2-1-5s'),
  SNAPGEN_DURATION_SECONDS: z.coerce.number().int().positive().default(5),
  SNAPGEN_ASPECT_RATIO: z.string().min(1).default('9:16'),
  SNAPGEN_RESOLUTION: z.string().min(1).default('720p'),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  INSTAGRAM_ACCOUNT_ID: z.string().default(''),
  META_ACCESS_TOKEN: z.string().default(''),
  INSTAGRAM_CONTAINER_POLL_SECONDS: z.coerce.number().int().positive().default(5),
  INSTAGRAM_CONTAINER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  INSTAGRAM_SHARE_TO_FEED: boolTrue,
  TIKTOK_ACCESS_TOKEN: z.string().default(''),
  TIKTOK_CLIENT_KEY: z.string().default(''),
  TIKTOK_CLIENT_SECRET: z.string().default(''),
  TIKTOK_REDIRECT_URI: z.string().url().default('http://localhost:8088/api/integrations/tiktok/callback/'),
  TIKTOK_POLL_SECONDS: z.coerce.number().int().positive().default(5),
  TIKTOK_PUBLISH_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  YOUTUBE_CLIENT_ID: z.string().default(''),
  YOUTUBE_CLIENT_SECRET: z.string().default(''),
  YOUTUBE_REFRESH_TOKEN: z.string().default(''),
  YOUTUBE_REDIRECT_URI: z.string().url().default('http://localhost:8088/api/integrations/youtube/callback/'),
  YOUTUBE_PRIVACY_STATUS: z.enum(['private', 'unlisted', 'public']).default('private'),
  MERCADO_LIVRE_CLIENT_ID: z.string().default(''),
  MERCADO_LIVRE_CLIENT_SECRET: z.string().default(''),
  MERCADO_LIVRE_REDIRECT_URI: z.string().url().default('https://affiliate-autopilot-achadinhos.woinsilva.chatgpt.site/'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Affiliate Autopilot <onboarding@resend.dev>'),
  EMAIL_TO: z.string().default(''),
  DAILY_REPORT_CRON: z.string().default('0 21 * * *'),
  WEEKLY_REPORT_CRON: z.string().default('0 20 * * 0'),
  DISCOVERY_CRON: z.string().default('0 */6 * * *'),
  ANALYTICS_CRON: z.string().default('15 */6 * * *'),
  TIMEZONE: z.string().default('America/Sao_Paulo'),
});

export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);

export function validateLiveConfiguration(): string[] {
  const issues: string[] = [];
  if (config.SNAPGEN_MODE === 'live' && !config.ALLOW_PAID_OPERATIONS) issues.push('SnapGen live exige ALLOW_PAID_OPERATIONS=true');
  if (config.SNAPGEN_MODE === 'live' && !config.SNAPGEN_API_KEY) issues.push('SNAPGEN_API_KEY ausente');
  if (config.PUBLISH_MODE === 'live' && !config.ALLOW_REAL_PUBLISHING) issues.push('Publicação real exige ALLOW_REAL_PUBLISHING=true');
  if (config.PUBLISH_MODE === 'live' && (!config.META_ACCESS_TOKEN || !config.INSTAGRAM_ACCOUNT_ID)) issues.push('Credenciais Meta ausentes');
  if (config.NOTIFICATION_MODE === 'resend' && (!config.RESEND_API_KEY || !config.EMAIL_TO)) issues.push('Credenciais/destinatário Resend ausentes');
  return issues;
}
