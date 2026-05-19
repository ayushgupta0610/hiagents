import OpenAI from 'openai';
import { env } from '../config.js';

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // OpenAI allows up to ~2048 inputs per call; batch defensively at 100.
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    batches.push(texts.slice(i, i + 100));
  }
  const all: number[][] = [];
  for (const batch of batches) {
    const res = await client.embeddings.create({
      model: MODEL,
      input: batch,
    });
    for (const row of res.data) {
      if (row.embedding.length !== DIMENSIONS) {
        throw new Error(`Unexpected embedding dim: ${row.embedding.length}`);
      }
      all.push(row.embedding);
    }
  }
  return all;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed([text]);
  if (!vec) throw new Error('embed returned empty');
  return vec;
}
