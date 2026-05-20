import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { extractPdf } from './pdf-extract.js';
import { chunkText } from './chunk.js';
import { embed } from '../providers/embeddings.js';
import { assertChunkCapacity, assertPdfSize } from '../tenant/limits.js';
import type { TenantSettings } from '../tenant/types.js';
import { audit } from '../tenant/audit.js';

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

export interface IngestResult {
  documentId: string;
  chunkCount: number;
}

export interface IngestContext {
  tenantId: string;
  settings: TenantSettings;
  actorEmail: string | null;
}

export async function ingestPdf(
  ctx: IngestContext,
  filename: string,
  buffer: Buffer,
): Promise<IngestResult> {
  assertPdfSize(buffer, ctx.settings);

  const supabase = db();

  const { data: doc, error: docErr } = await supabase
    .from('kb_documents')
    .insert({
      tenant_id: ctx.tenantId,
      filename,
      size_bytes: buffer.byteLength,
      status: 'pending',
    })
    .select()
    .single();
  if (docErr || !doc) throw new Error(`Failed to create document row: ${docErr?.message}`);

  try {
    const { text, pageCount } = await extractPdf(buffer);
    logger.info(
      { tenantId: ctx.tenantId, filename, pageCount, chars: text.length },
      'extracted PDF',
    );

    const chunks = chunkText(text, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP });
    logger.info({ tenantId: ctx.tenantId, filename, chunks: chunks.length }, 'chunked text');

    await assertChunkCapacity(ctx.tenantId, ctx.settings, chunks.length);

    const embeddings = await embed(chunks, ctx.tenantId);
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${chunks.length}`);
    }

    const rows = chunks.map((content, i) => ({
      tenant_id: ctx.tenantId,
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i]!,
    }));
    const { error: chunkErr } = await supabase.from('kb_chunks').insert(rows);
    if (chunkErr) throw new Error(`Failed to insert chunks: ${chunkErr.message}`);

    await supabase
      .from('kb_documents')
      .update({ status: 'ingested', chunk_count: chunks.length })
      .eq('id', doc.id)
      .eq('tenant_id', ctx.tenantId);

    await audit(ctx.tenantId, ctx.actorEmail, 'kb.upload', {
      filename,
      chunkCount: chunks.length,
    });
    return { documentId: doc.id, chunkCount: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('kb_documents')
      .update({ status: 'failed', error: message })
      .eq('id', doc.id)
      .eq('tenant_id', ctx.tenantId);
    throw err;
  }
}

export async function deleteDocument(ctx: IngestContext, documentId: string): Promise<void> {
  const { error } = await db()
    .from('kb_documents')
    .delete()
    .eq('id', documentId)
    .eq('tenant_id', ctx.tenantId);
  if (error) throw new Error(`Failed to delete document: ${error.message}`);
  await audit(ctx.tenantId, ctx.actorEmail, 'kb.delete', { documentId });
}

export async function listDocuments(tenantId: string) {
  const { data, error } = await db()
    .from('kb_documents')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(`Failed to list documents: ${error.message}`);
  return data;
}
