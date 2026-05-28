import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

export interface UsageRecord {
  tenantId: string;
  model: string;
  kind: 'chat' | 'embedding' | 'classifier';
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export async function recordUsage(rec: UsageRecord): Promise<void> {
  try {
    const total = rec.promptTokens + rec.completionTokens;
    await db().from('llm_usage').insert({
      tenant_id: rec.tenantId,
      model: rec.model,
      kind: rec.kind,
      prompt_tokens: rec.promptTokens,
      completion_tokens: rec.completionTokens,
      total_tokens: total,
      cost_usd: rec.costUsd.toFixed(6),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, tenantId: rec.tenantId, model: rec.model }, 'usage record failed');
  }
}

export interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  byModel: Array<{ model: string; tokens: number; costUsd: number }>;
}

export async function summarizeUsage(tenantId: string, sinceIso: string): Promise<UsageSummary> {
  const { data, error } = await db()
    .from('llm_usage')
    .select('model, total_tokens, cost_usd')
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`summarizeUsage: ${error.message}`);

  const rows = data ?? [];
  const byModelMap = new Map<string, { tokens: number; costUsd: number }>();
  let totalTokens = 0;
  let totalCost = 0;
  for (const r of rows as Array<{ model: string; total_tokens: number; cost_usd: string | number }>) {
    const tokens = Number(r.total_tokens) || 0;
    const cost = Number(r.cost_usd) || 0;
    totalTokens += tokens;
    totalCost += cost;
    const existing = byModelMap.get(r.model) ?? { tokens: 0, costUsd: 0 };
    existing.tokens += tokens;
    existing.costUsd += cost;
    byModelMap.set(r.model, existing);
  }
  return {
    totalTokens,
    totalCostUsd: totalCost,
    byModel: Array.from(byModelMap.entries()).map(([model, v]) => ({ model, ...v })),
  };
}
