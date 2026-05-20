import { env } from '../config.js';
import { recordUsage } from '../tenant/usage.js';

const MODEL = 'openai/text-embedding-3-small';
const DIMENSIONS = 1536;

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export async function embed(texts: string[], tenantId?: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 100) batches.push(texts.slice(i, i + 100));

  const all: number[][] = [];
  let totalTokens = 0;
  for (const batch of batches) {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': env.BASE_URL,
        'X-Title': 'inbox-ai',
      },
      body: JSON.stringify({ model: MODEL, input: batch }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter embeddings ${res.status}: ${text}`);
    }
    const json = (await res.json()) as EmbeddingResponse;
    for (const row of json.data) {
      if (row.embedding.length !== DIMENSIONS) {
        throw new Error(`Unexpected embedding dim: ${row.embedding.length}`);
      }
      all.push(row.embedding);
    }
    totalTokens += json.usage?.total_tokens ?? 0;
  }

  if (tenantId) {
    await recordUsage({
      tenantId,
      model: MODEL,
      kind: 'embedding',
      promptTokens: totalTokens,
      completionTokens: 0,
    });
  }

  return all;
}

export async function embedOne(text: string, tenantId?: string): Promise<number[]> {
  const [vec] = await embed([text], tenantId);
  if (!vec) throw new Error('embed returned empty');
  return vec;
}
