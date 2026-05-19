import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { env } from '../config.js';
import { listUnreadInbox, fetchMessage, markRead, applyLabel } from '../providers/gmail.js';
import { runPipeline } from '../pipeline/run.js';

let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.debug('previous tick still running, skipping');
    return;
  }
  running = true;
  try {
    const ids = await listUnreadInbox(25);
    if (ids.length === 0) return;
    logger.info({ count: ids.length }, 'polled inbox');

    for (const id of ids) {
      try {
        const email = await fetchMessage(id);
        const result = await runPipeline(email);
        // Always mark read so we don't reprocess
        await markRead(id);
        // Label so the user can see what the bot touched
        const label =
          result.replyStatus === 'sent'
            ? 'inbox-ai/replied'
            : result.classification === 'skipped_thread'
              ? 'inbox-ai/owner-took-over'
              : 'inbox-ai/skipped';
        await applyLabel(id, label);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, id }, 'pipeline failed for message');
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
  // node-cron supports per-second expressions: '*/N * * * * *'
  const expr = `*/${seconds} * * * * *`;
  cron.schedule(expr, tick);
  logger.info({ intervalSeconds: seconds }, 'gmail poller scheduled');
}
