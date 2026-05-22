import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

export type AuditAction =
  | 'tenant.provisioned'
  | 'tenant.soft_deleted'
  | 'tenant.hard_deleted'
  | 'settings.updated'
  | 'gmail.connected'
  | 'gmail.disconnected'
  | 'kb.upload'
  | 'kb.delete'
  | 'auth.signin'
  | 'auth.signin_failed'
  | 'auth.signout'
  | 'onboarding.completed';

export async function audit(
  tenantId: string,
  actorEmail: string | null,
  action: AuditAction,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db().from('audit_log').insert({
      tenant_id: tenantId,
      actor_email: actorEmail,
      action,
      metadata: metadata ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, tenantId, action }, 'audit log write failed');
  }
}

// Fire-and-forget audit for request handlers — same write but doesn't
// block the HTTP response on a DB round-trip. audit() already catches its
// own errors, so the explicit .catch is just belt-and-braces against the
// "unhandled promise rejection" warning if that ever changes.
//
// Use this from routes that just want to record the event and return; use
// `await audit(...)` from cron / batch paths where the surrounding process
// might exit before a detached write would land.
export function auditFireAndForget(
  tenantId: string,
  actorEmail: string | null,
  action: AuditAction,
  metadata?: Record<string, unknown>,
): void {
  void audit(tenantId, actorEmail, action, metadata).catch(() => {
    /* swallowed; audit() already logged */
  });
}
