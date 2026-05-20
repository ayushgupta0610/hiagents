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
