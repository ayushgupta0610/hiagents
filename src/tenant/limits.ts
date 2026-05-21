import { db } from '../db/client.js';
import type { TenantSettings } from './types.js';

export class LimitExceededError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function assertEmailQuota(tenantId: string, settings: TenantSettings): Promise<void> {
  const since = startOfUtcDayIso();
  const { count, error } = await db()
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('received_at', since);
  if (error) throw new Error(`assertEmailQuota: ${error.message}`);
  const cap = settings.limits.dailyEmailCap;
  if ((count ?? 0) >= cap) {
    throw new LimitExceededError(
      `Daily email cap reached: ${count} / ${cap} processed today (UTC). Raise it in Settings or wait until tomorrow.`,
      'daily-email-cap',
    );
  }
}

export async function assertChunkCapacity(
  tenantId: string,
  settings: TenantSettings,
  newChunks: number,
): Promise<void> {
  const { count, error } = await db()
    .from('kb_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`assertChunkCapacity: ${error.message}`);
  const cap = settings.limits.totalChunkCap;
  const current = count ?? 0;
  if (current + newChunks > cap) {
    throw new LimitExceededError(
      `KB capacity exceeded: ${current} existing + ${newChunks} new > cap of ${cap}. Delete some documents or raise the cap in Settings.`,
      'chunk-cap',
    );
  }
}

export function assertPdfSize(buffer: Buffer, settings: TenantSettings): void {
  if (buffer.byteLength > settings.limits.maxPdfBytes) {
    const mb = (buffer.byteLength / 1024 / 1024).toFixed(1);
    const capMb = (settings.limits.maxPdfBytes / 1024 / 1024).toFixed(0);
    throw new LimitExceededError(`PDF is ${mb} MB, exceeds cap of ${capMb} MB.`, 'pdf-size');
  }
}

function normaliseEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}

/**
 * Throws if the bot has already replied to this sender N times today,
 * where N is the per-tenant cap (default 5). Prevents reply-flood abuse
 * where one sender keeps emailing to burn LLM credits.
 */
export async function assertPerSenderReplyQuota(
  tenantId: string,
  settings: TenantSettings,
  fromHeader: string,
): Promise<void> {
  const cap = settings.limits.perSenderDailyReplyCap;
  if (cap <= 0) return; // 0 disables the check
  const sinceUtc = startOfUtcDayIso();
  const sender = normaliseEmail(fromHeader);
  if (!sender) return;
  // We count actual sent replies (not skipped) to a sender today. The DB
  // doesn't have a "to" column on messages — `from_address` IS the inbound
  // sender, and `reply_status='sent'` means we sent a reply to them. So
  // counting messages with this from_address + sent reply gives us the
  // per-sender reply count.
  const { count, error } = await db()
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('from_address', fromHeader) // exact match preserves the raw header
    .eq('reply_status', 'sent')
    .gte('received_at', sinceUtc);
  // Also check with normalised email in case header format varies
  const { count: countNormalised } = await db()
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .ilike('from_address', `%${sender}%`)
    .eq('reply_status', 'sent')
    .gte('received_at', sinceUtc);
  if (error) throw new Error(`assertPerSenderReplyQuota: ${error.message}`);
  const totalCount = Math.max(count ?? 0, countNormalised ?? 0);
  if (totalCount >= cap) {
    throw new LimitExceededError(
      `Per-sender daily reply cap reached for ${sender}: ${totalCount} / ${cap} today (UTC). Bot will not reply again until tomorrow.`,
      'per-sender-cap',
    );
  }
}

/**
 * Throws if the tenant has spent more than the daily USD cap on LLM calls today.
 * Reads from llm_usage. Cap is per-tenant configurable; default $5/day.
 *
 * This is the global cost kill-switch — protects you (the operator) from a
 * runaway tenant burning your shared OpenRouter key.
 */
export async function assertDailySpendCap(
  tenantId: string,
  settings: TenantSettings,
): Promise<void> {
  const cap = settings.limits.dailySpendCapUsd;
  if (cap <= 0) return; // 0 disables the check
  const sinceUtc = startOfUtcDayIso();
  const { data, error } = await db()
    .from('llm_usage')
    .select('cost_usd')
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceUtc);
  if (error) throw new Error(`assertDailySpendCap: ${error.message}`);
  let spent = 0;
  for (const row of (data ?? []) as Array<{ cost_usd: string | number }>) {
    spent += Number(row.cost_usd) || 0;
  }
  if (spent >= cap) {
    throw new LimitExceededError(
      `Daily LLM spend cap reached: $${spent.toFixed(4)} / $${cap.toFixed(2)} today (UTC). Raise it in Settings → Limits or wait until tomorrow.`,
      'daily-spend-cap',
    );
  }
}
