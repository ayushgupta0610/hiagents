import { db } from '../db/client.js';
import { embedOne } from '../providers/embeddings.js';
import type { RetrievedChunk } from '../types.js';
import type { TenantSettings } from '../tenant/types.js';

export async function search(
  tenantId: string,
  settings: TenantSettings,
  query: string,
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedOne(query, tenantId);
  const { data, error } = await db().rpc('match_kb_chunks', {
    query_embedding: queryEmbedding,
    in_tenant_id: tenantId,
    match_count: settings.retrieval.topK,
    similarity_threshold: settings.retrieval.similarityThreshold,
  });
  if (error) throw new Error(`Vector search failed: ${error.message}`);
  return (data ?? []).map(
    (row: { id: string; document_id: string; content: string; similarity: number }) => ({
      id: row.id,
      documentId: row.document_id,
      content: row.content,
      similarity: row.similarity,
    }),
  );
}
