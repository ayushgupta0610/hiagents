import { db } from '../src/db/client.js';

const supabase = db();
const { data: tokens, error: e1 } = await supabase.from('oauth_tokens').select('*');
const { data: docs, error: e2 } = await supabase
  .from('kb_documents')
  .select('id, filename, status, chunk_count, error, uploaded_at');
const { count: chunkCount } = await supabase
  .from('kb_chunks')
  .select('*', { count: 'exact', head: true });
const { count: msgCount } = await supabase
  .from('messages')
  .select('*', { count: 'exact', head: true });

console.log('oauth_tokens rows:', tokens?.length ?? 0, e1 ? 'ERROR: ' + e1.message : '');
if (tokens?.length) {
  for (const t of tokens) {
    console.log('  ', { id: t.id, email: t.email, updated_at: t.updated_at, expires_at: t.expires_at });
  }
}
console.log('kb_documents rows:', docs?.length ?? 0, e2 ? 'ERROR: ' + e2.message : '');
if (docs?.length) for (const d of docs) console.log('  ', d);
console.log('kb_chunks count:', chunkCount);
console.log('messages count:', msgCount);
