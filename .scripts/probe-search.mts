// Usage: npx tsx .scripts/probe-search.mts "your query here"
// Shows the top 10 KB chunk matches for a query, with similarity scores
// and ignoring SIMILARITY_THRESHOLD entirely so you can see what the bot
// would have found at any threshold.

import { db } from '../src/db/client.js';
import { embedOne } from '../src/providers/embeddings.js';
import { env } from '../src/config.js';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npx tsx .scripts/probe-search.mts "your query here"');
  process.exit(1);
}

console.log('Query:', JSON.stringify(query));
console.log('Configured threshold:', env.SIMILARITY_THRESHOLD, '| TOP_K:', env.TOP_K);
console.log('Embedding…');

const vec = await embedOne(query);

const { data, error } = await db().rpc('match_kb_chunks', {
  query_embedding: vec,
  match_count: 10,
  similarity_threshold: 0, // unfiltered — show everything
});
if (error) {
  console.error('Search error:', error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.log('\nNo chunks returned at all. Either the KB is empty or the RPC is broken.');
  process.exit(0);
}

console.log(`\nTop ${data.length} matches:\n`);
for (const row of data as Array<{ similarity: number; content: string; document_id: string }>) {
  const passesThreshold = row.similarity >= env.SIMILARITY_THRESHOLD;
  const marker = passesThreshold ? '✓' : '✗';
  const preview = row.content.replace(/\s+/g, ' ').slice(0, 200);
  console.log(`${marker} sim=${row.similarity.toFixed(3)} doc=${row.document_id.slice(0, 8)}`);
  console.log(`   "${preview}${row.content.length > 200 ? '…' : ''}"`);
  console.log();
}

console.log(`\n✓ = above current threshold (${env.SIMILARITY_THRESHOLD})  ✗ = below`);
