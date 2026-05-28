import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');

const sb = createClient(url, key);
const EMAIL = process.argv[2] ?? process.env.INSPECT_EMAIL;
if (!EMAIL) {
  console.error('Usage: tsx qa/scripts/inspect-usage.ts <email>  (or INSPECT_EMAIL=…)');
  process.exit(1);
}

const { data: tokenRows, error: tokErr } = await sb
  .from('oauth_tokens')
  .select('tenant_id, email')
  .ilike('email', EMAIL);
if (tokErr) throw tokErr;
const tenantIds = (tokenRows ?? []).map((r: { tenant_id: string }) => r.tenant_id);
if (tenantIds.length === 0) {
  console.error(`no oauth_tokens row for ${EMAIL}`);
  process.exit(1);
}
console.log(`found ${tenantIds.length} tenant(s) for ${EMAIL}: ${tenantIds.join(', ')}`);

const { data: tenantsMeta } = await sb
  .from('tenants')
  .select('id, name, created_at, deleted_at')
  .in('id', tenantIds);
console.log('tenants metadata:');
for (const t of (tenantsMeta ?? []) as Array<{ id: string; name: string; created_at: string; deleted_at: string | null }>) {
  console.log(`  ${t.id}  name="${t.name}"  created=${t.created_at}  deleted=${t.deleted_at ?? 'no'}`);
}

const liveTenants = (tenantsMeta ?? []).filter((t: { deleted_at: string | null }) => !t.deleted_at).map((t: { id: string }) => t.id);
const tenantId = liveTenants[0];
if (!tenantId) {
  console.error('no live tenant for this email');
  process.exit(1);
}
console.log(`\nanalyzing live tenant: ${tenantId}`);

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const { count: msgCount } = await sb
  .from('messages')
  .select('*', { count: 'exact', head: true })
  .eq('tenant_id', tenantId)
  .gte('created_at', since);
console.log(`messages rows in last 30d: ${msgCount}`);

const { data: usage, error: usageErr } = await sb
  .from('llm_usage')
  .select('model, kind, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at')
  .eq('tenant_id', tenantId)
  .gte('created_at', since)
  .order('created_at', { ascending: false });
if (usageErr) throw usageErr;

const rows = usage ?? [];
console.log(`\nllm_usage rows in last 30d: ${rows.length}`);

interface Bucket { rows: number; prompt: number; completion: number; cost: number; zeroCost: number }
const byModel = new Map<string, Bucket>();
let totalCost = 0;
let totalPrompt = 0;
let totalCompletion = 0;
let zeroCostRows = 0;

for (const r of rows as Array<{ model: string; kind: string; prompt_tokens: number; completion_tokens: number; cost_usd: string | number }>) {
  const cost = Number(r.cost_usd) || 0;
  const p = Number(r.prompt_tokens) || 0;
  const c = Number(r.completion_tokens) || 0;
  totalCost += cost;
  totalPrompt += p;
  totalCompletion += c;
  if (cost === 0) zeroCostRows += 1;
  const key = `${r.model} (${r.kind})`;
  const b = byModel.get(key) ?? { rows: 0, prompt: 0, completion: 0, cost: 0, zeroCost: 0 };
  b.rows += 1;
  b.prompt += p;
  b.completion += c;
  b.cost += cost;
  if (cost === 0) b.zeroCost += 1;
  byModel.set(key, b);
}

console.log(`\ntotal prompt tokens:     ${totalPrompt.toLocaleString()}`);
console.log(`total completion tokens: ${totalCompletion.toLocaleString()}`);
console.log(`total cost_usd:          $${totalCost.toFixed(6)}`);
console.log(`rows with cost_usd = 0:  ${zeroCostRows} / ${rows.length}`);

console.log(`\nby model+kind:`);
const sorted = Array.from(byModel.entries()).sort((a, b) => b[1].rows - a[1].rows);
for (const [k, b] of sorted) {
  console.log(`  ${k.padEnd(45)} rows=${String(b.rows).padStart(4)} zero=${String(b.zeroCost).padStart(4)} prompt=${b.prompt.toLocaleString().padStart(10)} compl=${b.completion.toLocaleString().padStart(7)} cost=$${b.cost.toFixed(6)}`);
}

console.log(`\nfirst 3 rows (most recent):`);
for (const r of rows.slice(0, 3)) {
  console.log(`  ${JSON.stringify(r)}`);
}
console.log(`\noldest 3 rows:`);
for (const r of rows.slice(-3)) {
  console.log(`  ${JSON.stringify(r)}`);
}

console.log(`\n--- all-time, all tenants for ${EMAIL} ---`);
const { data: allRows, error: allErr } = await sb
  .from('llm_usage')
  .select('tenant_id, model, kind, prompt_tokens, completion_tokens, cost_usd')
  .in('tenant_id', tenantIds);
if (allErr) throw allErr;
let allTotal = 0;
let allRowCount = 0;
let allZero = 0;
const byTenant = new Map<string, { rows: number; cost: number }>();
for (const r of (allRows ?? []) as Array<{ tenant_id: string; cost_usd: string | number }>) {
  const c = Number(r.cost_usd) || 0;
  allTotal += c;
  allRowCount += 1;
  if (c === 0) allZero += 1;
  const b = byTenant.get(r.tenant_id) ?? { rows: 0, cost: 0 };
  b.rows += 1;
  b.cost += c;
  byTenant.set(r.tenant_id, b);
}
console.log(`all-time rows across ${tenantIds.length} tenants: ${allRowCount}`);
console.log(`all-time total cost_usd: $${allTotal.toFixed(6)}`);
console.log(`all-time rows with cost_usd = 0: ${allZero}`);
console.log(`per-tenant breakdown:`);
for (const [tid, b] of byTenant.entries()) {
  console.log(`  ${tid}  rows=${b.rows}  cost=$${b.cost.toFixed(6)}`);
}

console.log(`\n--- platform-wide all-time (every tenant on this deployment) ---`);
const { data: platRows } = await sb
  .from('llm_usage')
  .select('cost_usd');
let platTotal = 0;
let platCount = 0;
for (const r of (platRows ?? []) as Array<{ cost_usd: string | number }>) {
  platTotal += Number(r.cost_usd) || 0;
  platCount += 1;
}
console.log(`platform rows: ${platCount}, total cost_usd: $${platTotal.toFixed(6)}`);
