import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { env } from '../config.js';
import { listUnreadInbox, fetchMessage, markRead, applyLabel } from '../providers/gmail.js';
import { runPipeline } from '../pipeline/run.js';
import { listOnboardedTenants, type Tenant } from '../tenant/store.js';
import { db } from '../db/client.js';

let running = false;

// Per-tick concurrency cap for tenant polling. Too low (1) and 100 tenants
// take 20+ seconds per tick (300ms × 100 sequentially). Too high (unbounded)
// and we thundering-herd four shared downstreams — Gmail project quota,
// OpenRouter rate limit, Supabase pgbouncer pool, and process memory. 10
// keeps wall-clock predictable (~2s for 100 tenants), well inside a 60s
// cycle, and stays under typical per-org LLM rate limits.
const POLL_CONCURRENCY = 10;

// Simple bounded-concurrency runner. We don't want a p-limit dep; this is
// 8 lines and behaves identically for our use case. Returns when every
// task settles (success or rejection — each tenant's failure is logged
// inside processTenant so we don't lose context here).
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      try {
        await fn(next);
      } catch {
        /* errors handled by caller */
      }
    }
  });
  await Promise.all(workers);
}

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
          ? 'hiagents/replied'
          : result.classification === 'skipped_thread'
            ? 'hiagents/owner-took-over'
            : 'hiagents/skipped';
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
        await applyLabel(tenant.id, id, 'hiagents/failed');
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

    const eligible = tenants.filter((t) => {
      if (t.settings.polling.paused) {
        logger.debug({ tenantId: t.id }, 'tenant paused — skipping');
        return false;
      }
      return ownerByTenant.has(t.id);
    });

    const tickStart = Date.now();
    await runWithConcurrency(eligible, POLL_CONCURRENCY, async (t) => {
      const owner = ownerByTenant.get(t.id);
      if (!owner) return;
      try {
        await processTenant(t, owner);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tenantId: t.id, err: msg }, 'tenant poll failed');
      }
    });
    const tickMs = Date.now() - tickStart;
    if (eligible.length > 0) {
      logger.info(
        { tenantCount: eligible.length, concurrency: POLL_CONCURRENCY, ms: tickMs },
        'poll tick complete',
      );
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
