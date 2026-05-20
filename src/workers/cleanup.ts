import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { audit } from '../tenant/audit.js';

const GRACE_DAYS = 30;

async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: tenants, error } = await db()
    .from('tenants')
    .select('id, created_by_email')
    .lt('deleted_at', cutoff);
  if (error) {
    logger.error({ err: error.message }, 'cleanup: list failed');
    return;
  }

  for (const t of (tenants ?? []) as Array<{ id: string; created_by_email: string | null }>) {
    try {
      await audit(t.id, t.created_by_email, 'tenant.hard_deleted', { graceDays: GRACE_DAYS });
      const { error: dErr } = await db().from('tenants').delete().eq('id', t.id);
      if (dErr) {
        logger.error({ tenantId: t.id, err: dErr.message }, 'cleanup: delete failed');
        continue;
      }
      logger.info({ tenantId: t.id }, 'hard-deleted tenant after grace period');
    } catch (err) {
      logger.error(
        { tenantId: t.id, err: err instanceof Error ? err.message : String(err) },
        'cleanup tenant failed',
      );
    }
  }
}

export function startCleanupCron(): void {
  // Run every day at 03:00 UTC
  cron.schedule('0 3 * * *', tick);
  logger.info('daily cleanup cron scheduled (03:00 UTC)');
}
