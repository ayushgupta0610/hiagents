import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { z } from 'zod';

loadEnv();
if (existsSync('.env.local')) {
  loadEnv({ path: '.env.local', override: true });
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  BASE_URL: z.url(),

  // Supabase
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  // OpenRouter (used for embeddings, classifier, reply)
  OPENROUTER_API_KEY: z.string().min(10),

  // Google OAuth (shared across all tenants)
  GOOGLE_CLIENT_ID: z.string().min(10),
  GOOGLE_CLIENT_SECRET: z.string().min(10),
  GOOGLE_REDIRECT_URI: z.url(),

  // Admin (HMAC secret + password fallback login)
  ADMIN_PASSWORD: z.string().min(8),

  // Poller cadence (applies to every tenant)
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env: Env = parsed.data;
