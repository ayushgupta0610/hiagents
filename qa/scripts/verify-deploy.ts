import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');

const sb = createClient(url, key);

console.log('=== watermark column check ===');
const { data: tokens, error: tokErr } = await sb
  .from('oauth_tokens')
  .select('tenant_id, email, connected_at, updated_at');
if (tokErr) throw tokErr;
console.log(`oauth_tokens rows: ${tokens?.length ?? 0}`);
for (const r of (tokens ?? []) as Array<{ tenant_id: string; email: string; connected_at: string | null; updated_at: string }>) {
  console.log(`  tenant=${r.tenant_id}  email=${r.email}  connected_at=${r.connected_at ?? 'NULL'}  updated_at=${r.updated_at}`);
}

console.log('\n=== recent llm_usage rows (last 6 h, all tenants) ===');
const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
const { data: usage } = await sb
  .from('llm_usage')
  .select('created_at, tenant_id, model, kind, prompt_tokens, completion_tokens, cost_usd')
  .gte('created_at', sixHoursAgo)
  .order('created_at', { ascending: false });

const rows = (usage ?? []) as Array<{
  created_at: string;
  tenant_id: string;
  model: string;
  kind: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: string | number;
}>;
console.log(`rows in last 6h: ${rows.length}`);
let zeroCost = 0;
for (const r of rows.slice(0, 12)) {
  const c = Number(r.cost_usd) || 0;
  if (c === 0) zeroCost += 1;
  console.log(
    `  ${r.created_at}  ${r.model.padEnd(35)} ${r.kind.padEnd(11)} p=${String(r.prompt_tokens).padStart(5)} c=${String(r.completion_tokens).padStart(4)} cost=$${c.toFixed(6)}`,
  );
}
console.log(`zero-cost in last 6h: ${rows.filter((r) => Number(r.cost_usd) === 0).length} / ${rows.length}`);

console.log('\n=== platform total since 6 h ago ===');
let sumCost = 0;
let sumPrompt = 0;
let sumCompl = 0;
for (const r of rows) {
  sumCost += Number(r.cost_usd) || 0;
  sumPrompt += Number(r.prompt_tokens) || 0;
  sumCompl += Number(r.completion_tokens) || 0;
}
console.log(`prompt tokens=${sumPrompt.toLocaleString()}  completion=${sumCompl.toLocaleString()}  cost=$${sumCost.toFixed(6)}`);
