import { db } from '../db/client.js';
import { embedOne } from '../providers/embeddings.js';
import { env } from '../config.js';
import type { RetrievedChunk } from '../types.js';

export async function search(query: string): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedOne(query);
  const { data, error } = await db().rpc('match_kb_chunks', {
    query_embedding: queryEmbedding,
    match_count: env.TOP_K,
    similarity_threshold: env.SIMILARITY_THRESHOLD,
  });
  if (error) throw new Error(`Vector search failed: ${error.message}`);
  return (data ?? []).map((row: { id: string; document_id: string; content: string; similarity: number }) => ({
    id: row.id,
    documentId: row.document_id,
    content: row.content,
    similarity: row.similarity,
  }));
}
