// Sanity-check the priceFor() function end-to-end:
//   1. Embedding model (uncatalogued) → should hit FALLBACK_PRICING, return non-zero
//   2. Known chat model (in catalog) → should match catalog
//   3. Unknown model → should return 0 with warn log
import 'dotenv/config';
import { priceFor } from '../../src/providers/pricing.js';

console.log('=== priceFor() verification ===\n');

console.log('1. EMBEDDING — openai/text-embedding-3-small, 1000 tokens');
const emb = await priceFor('openai/text-embedding-3-small', 1000, 0);
console.log(`   result: $${emb.toFixed(8)}  (expected: $0.00002000 = $0.02/M × 1000)`);
console.log(`   ${Math.abs(emb - 0.00002) < 1e-10 ? '✓ PASS' : '✗ FAIL'}\n`);

console.log('2. KNOWN CHAT — openai/gpt-4o-mini, 1000 prompt + 100 completion');
const chat = await priceFor('openai/gpt-4o-mini', 1000, 100);
const expected = (1000 * 0.15 + 100 * 0.6) / 1_000_000;
console.log(`   result: $${chat.toFixed(8)}  (expected: $${expected.toFixed(8)} = ($0.15/M × 1000) + ($0.60/M × 100))`);
console.log(`   ${Math.abs(chat - expected) < 1e-10 ? '✓ PASS' : '✗ FAIL'}\n`);

console.log('3. UNKNOWN — fictional/nonexistent-model, 1000 tokens');
const unknown = await priceFor('fictional/nonexistent-model', 1000, 100);
console.log(`   result: $${unknown.toFixed(8)}  (expected: $0)`);
console.log(`   ${unknown === 0 ? '✓ PASS' : '✗ FAIL'} (with warn log above)\n`);

console.log('4. EMBEDDING LARGE — openai/text-embedding-3-large, 1000 tokens');
const emb2 = await priceFor('openai/text-embedding-3-large', 1000, 0);
console.log(`   result: $${emb2.toFixed(8)}  (expected: $0.00013000 = $0.13/M × 1000)`);
console.log(`   ${Math.abs(emb2 - 0.00013) < 1e-10 ? '✓ PASS' : '✗ FAIL'}\n`);
