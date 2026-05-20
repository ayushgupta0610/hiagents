// Usage:
//   npx tsx .scripts/probe-pipeline.mts \
//     --from "sender@example.com" \
//     --subject "Query" \
//     --body "Hi, can you tell me what the /clear command does?"
//
// Runs the full email through classifier + retrieval (but NOT reply generation
// or send) so you can see exactly what would have happened with a real email.

import { classify } from '../src/pipeline/classifier.js';
import { search } from '../src/kb/search.js';
import { embedOne } from '../src/providers/embeddings.js';
import { env } from '../src/config.js';
import { db } from '../src/db/client.js';

function getArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return null;
  return process.argv[i + 1] ?? null;
}

const from = getArg('from') || 'test@example.com';
const subject = getArg('subject') || 'Query';
const body = getArg('body');
if (!body) {
  console.error('Usage: --from <email> --subject <text> --body <text>');
  process.exit(1);
}

console.log('=== INPUT ===');
console.log('From:    ', from);
console.log('Subject: ', subject);
console.log('Body:    ', body);
console.log();

console.log('=== CLASSIFIER ===');
console.log('Model:  ', env.CLASSIFIER_MODEL);
console.log('Custom prompt:', env.CLASSIFIER_PROMPT ? 'YES (env-overridden)' : 'no (using default)');
const verdict = await classify({ from, subject, bodyText: body });
console.log('Verdict:', verdict === 'client_query' ? '✓ client_query (would proceed to retrieval)' : '✗ other (would skip — reply_reason: classifier-other)');
console.log();

if (verdict !== 'client_query') {
  console.log('Bot would stop here. No reply sent.');
  process.exit(0);
}

console.log('=== RETRIEVAL ===');
console.log('Threshold:', env.SIMILARITY_THRESHOLD, '| TOP_K:', env.TOP_K);
const query = `${subject}\n\n${body}`;
const chunks = await search(query);
console.log(`Chunks returned (above threshold): ${chunks.length}`);
if (chunks.length === 0) {
  console.log();
  console.log('Bot would skip — reply_reason: no-kb-match');
  console.log('Top matches below threshold (would not be sent to LLM):');
  const vec = await embedOne(query);
  const { data } = await db().rpc('match_kb_chunks', {
    query_embedding: vec,
    match_count: 5,
    similarity_threshold: 0,
  });
  for (const row of (data ?? []) as Array<{ similarity: number; content: string }>) {
    console.log(`  sim=${row.similarity.toFixed(3)}: "${row.content.replace(/\s+/g, ' ').slice(0, 120)}…"`);
  }
  process.exit(0);
}

for (const c of chunks) {
  console.log(`  ✓ sim=${c.similarity.toFixed(3)}: "${c.content.replace(/\s+/g, ' ').slice(0, 120)}…"`);
}
console.log();
console.log('=== WOULD SEND REPLY ===');
console.log('At this point the bot would call', env.REPLY_MODEL, 'with these chunks as context and send the response via Gmail.');
console.log('(Reply generation skipped in probe to save tokens. Real email would land in inbox in ~5-10s.)');
