import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { extractPdf } from './pdf-extract.js';
import { chunkText } from './chunk.js';
import { embed } from '../providers/embeddings.js';

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

export interface IngestResult {
  documentId: string;
  chunkCount: number;
}

export async function ingestPdf(
  filename: string,
  buffer: Buffer,
): Promise<IngestResult> {
  const supabase = db();

  // 1. Insert document row (pending)
  const { data: doc, error: docErr } = await supabase
    .from('kb_documents')
    .insert({ filename, size_bytes: buffer.byteLength, status: 'pending' })
    .select()
    .single();
  if (docErr || !doc) {
    throw new Error(`Failed to create document row: ${docErr?.message}`);
  }

  try {
    // 2. Extract text
    const { text, pageCount } = await extractPdf(buffer);
    logger.info({ filename, pageCount, chars: text.length }, 'extracted PDF');

    // 3. Chunk
    const chunks = chunkText(text, {
      chunkSize: CHUNK_SIZE,
      overlap: CHUNK_OVERLAP,
    });
    logger.info({ filename, chunks: chunks.length }, 'chunked text');

    // 4. Embed
    const embeddings = await embed(chunks);
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`,
      );
    }

    // 5. Insert chunks
    // Length check above lets us safely assert non-null on the indexed access
    // (noUncheckedIndexedAccess would otherwise widen embeddings[i] to
    //  number[] | undefined).
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i]!,
    }));
    const { error: chunkErr } = await supabase.from('kb_chunks').insert(rows);
    if (chunkErr) throw new Error(`Failed to insert chunks: ${chunkErr.message}`);

    // 6. Mark document ingested
    await supabase
      .from('kb_documents')
      .update({ status: 'ingested', chunk_count: chunks.length })
      .eq('id', doc.id);

    return { documentId: doc.id, chunkCount: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('kb_documents')
      .update({ status: 'failed', error: message })
      .eq('id', doc.id);
    throw err;
  }
}

export async function deleteDocument(documentId: string): Promise<void> {
  // Cascade deletes chunks via FK
  const { error } = await db()
    .from('kb_documents')
    .delete()
    .eq('id', documentId);
  if (error) throw new Error(`Failed to delete document: ${error.message}`);
}

export async function listDocuments() {
  const { data, error } = await db()
    .from('kb_documents')
    .select('*')
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(`Failed to list documents: ${error.message}`);
  return data;
}
