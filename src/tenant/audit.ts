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
