import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  // Supabase
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  // Embeddings
  OPENAI_API_KEY: z.string().min(10),

  // Generation
  OPENROUTER_API_KEY: z.string().min(10),
  CLASSIFIER_MODEL: z.string().default('openai/gpt-4o-mini'),
  REPLY_MODEL: z.string().default('anthropic/claude-sonnet-4-5'),

  // Gmail OAuth
  GOOGLE_CLIENT_ID: z.string().min(10),
  GOOGLE_CLIENT_SECRET: z.string().min(10),
  GOOGLE_REDIRECT_URI: z.url(),
  GMAIL_ADDRESS: z.email(),

  // Admin
  ADMIN_PASSWORD: z.string().min(8),
  BASE_URL: z.url(),

  // Tuning
  SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  TOP_K: z.coerce.number().int().positive().default(5),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  // Persona
  SIGNATURE: z.string().default('— Sent by inbox-ai'),
  TONE: z.string().default('professional, warm, concise'),
  COMPANY_DESCRIPTION: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env: Env = parsed.data;
