import { env } from '../config.js';
import { logger } from '../lib/logger.js';

interface ModelPricing {
  prompt: number;
  completion: number;
}

interface Catalog {
  fetchedAt: number;
  models: Map<string, ModelPricing>;
}

interface ModelsResponse {
  data?: Array<{
    id: string;
    pricing?: { prompt?: string; completion?: string };
  }>;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY: Catalog = { fetchedAt: 0, models: new Map() };

let cached: Catalog | null = null;
let inflight: Promise<Catalog> | null = null;

async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const json = (await res.json()) as ModelsResponse;
  const models = new Map<string, ModelPricing>();
  for (const m of json.data ?? []) {
    const prompt = Number(m.pricing?.prompt ?? 0);
    const completion = Number(m.pricing?.completion ?? 0);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      models.set(m.id, { prompt, completion });
    }
  }
  return { fetchedAt: Date.now(), models };
}

async function getCatalog(): Promise<Catalog> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .then((c) => {
      cached = c;
      return c;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'pricing catalog fetch failed');
      return cached ?? EMPTY;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function priceFor(
  model: string,
  promptTokens: number,
  completionTokens: number
): Promise<number> {
  const catalog = await getCatalog();
  const p = catalog.models.get(model);
  if (!p) {
    logger.warn({ model }, 'pricing catalog miss — recording cost as 0');
    return 0;
  }
  return promptTokens * p.prompt + completionTokens * p.completion;
}
