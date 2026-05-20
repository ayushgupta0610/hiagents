import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { env } from '../config.js';
import { listUnreadInbox, fetchMessage, markRead, applyLabel } from '../providers/gmail.js';
import { runPipeline } from '../pipeline/run.js';
import { listOnboardedTenants, type Tenant } from '../tenant/store.js';
import { db } from '../db/client.js';

let running = false;

async function processTenant(tenant: Tenant, ownerEmail: string): Promise<void> {
  let ids: string[];
  try {
    ids = await listUnreadInbox(tenant.id, 25);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tenantId: tenant.id, err: msg }, 'poll: list inbox failed; skipping this tick');
    return;
  }
  if (ids.length === 0) return;
  logger.info({ tenantId: tenant.id, count: ids.length }, 'polled inbox');

  for (const id of ids) {
    try {
      const email = await fetchMessage(tenant.id, id);
      const result = await runPipeline({ tenant, ownerEmail }, email);
      try {
        await markRead(tenant.id, id);
      } catch {
        /* ignore */
      }
      const label =
        result.replyStatus === 'sent'
          ? 'inbox-ai/replied'
          : result.classification === 'skipped_thread'
            ? 'inbox-ai/owner-took-over'
            : 'inbox-ai/skipped';
      try {
        await applyLabel(tenant.id, id, label);
      } catch {
        /* ignore */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ tenantId: tenant.id, id, err: msg }, 'pipeline failed for message');
      try {
        await markRead(tenant.id, id);
      } catch {
        /* ignore */
      }
      try {
        await applyLabel(tenant.id, id, 'inbox-ai/failed');
      } catch {
        /* ignore */
      }
    }
  }
}

async function tick(): Promise<void> {
  if (running) {
    logger.debug('previous tick still running, skipping');
    return;
  }
  running = true;
  try {
    const tenants = await listOnboardedTenants();
    if (tenants.length === 0) return;

    const { data: tokens } = await db().from('oauth_tokens').select('tenant_id, email');
    const ownerByTenant = new Map<string, string>();
    for (const row of (tokens ?? []) as Array<{ tenant_id: string; email: string }>) {
      ownerByTenant.set(row.tenant_id, row.email);
    }

    for (const t of tenants) {
      const owner = ownerByTenant.get(t.id);
      if (!owner) continue;
      try {
        await processTenant(t, owner);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tenantId: t.id, err: msg }, 'tenant poll failed');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'poll tick failed');
  } finally {
    running = false;
  }
}

export function startPoller(): void {
  const seconds = env.POLL_INTERVAL_SECONDS;
  const expr = `*/${seconds} * * * * *`;
  cron.schedule(expr, tick);
  logger.info({ intervalSeconds: seconds }, 'multi-tenant gmail poller scheduled');
}
