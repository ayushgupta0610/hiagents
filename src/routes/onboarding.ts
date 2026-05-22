import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin, csrfGuard, issueCsrfToken } from '../lib/auth.js';
import {
  updateSettings,
  markOnboardingComplete,
  getTenant,
  softDeleteTenant,
} from '../tenant/store.js';
import { auditFireAndForget } from '../tenant/audit.js';
import { clearSession } from '../lib/auth.js';
import { sendError } from '../lib/errors.js';
import { db } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const onboardingRouter: Router = Router();

function requireTenant(res: import('express').Response): string | null {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    sendError(res, 400, {
      code: 'tenant-required',
      message: 'Sign in with Google to start onboarding.',
    });
    return null;
  }
  return tenantId;
}

onboardingRouter.get('/', requireAdmin, async (_req, res) => {
  issueCsrfToken(res);
  const html = await readFile(path.join(__dirname, '..', 'ui', 'onboarding.html'), 'utf-8');
  res.type('html').send(html);
});

onboardingRouter.get('/api/state', requireAdmin, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    sendError(res, 404, { code: 'not-found', message: 'This workspace no longer exists.' });
    return;
  }

  const { data: oauth } = await db()
    .from('oauth_tokens')
    .select('email')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const { count: docsCount } = await db()
    .from('kb_documents')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'ingested');

  // Heuristic: "welcome" is done if the tenant name has been customised away from the
  // auto-provisioned default (the email's local part).
  const looksAutoProvisioned = tenant.name === (tenant.createdByEmail?.split('@')[0] ?? '');

  res.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      onboardingCompletedAt: tenant.onboardingCompletedAt,
    },
    steps: {
      welcome: !!tenant.name && !looksAutoProvisioned,
      mailbox: !!oauth?.email,
      // Persona is "done" once the user has explicitly submitted the step at
      // least once. companyDescription is no longer required, so we can't use
      // it as the signal anymore.
      persona: !!tenant.settings.persona.configured,
      kb: (docsCount ?? 0) > 0,
      // Classifier shows "done" only after the full wizard is complete — during the
      // wizard itself, it's the step the user is currently on (or hasn't reached yet),
      // so showing it as already-done was misleading the progress bar.
      classifier: !!tenant.onboardingCompletedAt,
      done: !!tenant.onboardingCompletedAt,
    },
  });
});

onboardingRouter.post('/api/welcome', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) {
    sendError(res, 400, {
      code: 'validation-failed',
      message: 'Workspace name is required and must be 80 characters or fewer.',
    });
    return;
  }
  const { error } = await db().from('tenants').update({ name }).eq('id', tenantId);
  if (error) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't save your workspace name. Please try again.",
      internal: error,
    });
    return;
  }
  res.json({ ok: true });
});

onboardingRouter.post('/api/persona', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const { signature, tone, companyDescription } = req.body ?? {};
  // All three are optional during onboarding; the user can keep defaults and
  // refine later in Settings. We coerce undefined / null → '' so the merge
  // doesn't store the wrong type.
  const safeSig = typeof signature === 'string' ? signature : '';
  const safeTone = typeof tone === 'string' ? tone : '';
  const safeCompany = typeof companyDescription === 'string' ? companyDescription : '';
  try {
    await updateSettings(tenantId, {
      persona: {
        signature: safeSig.slice(0, 200),
        tone: safeTone.slice(0, 200),
        companyDescription: safeCompany.slice(0, 1000),
        // Mark the step as visited so the onboarding routing can move past it
        // even if the user didn't customize anything.
        configured: true,
      },
    });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't save your persona. Please try again in a moment.",
      internal: e,
    });
  }
});

onboardingRouter.post('/api/classifier', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (prompt.length > 2000) {
    sendError(res, 400, {
      code: 'validation-failed',
      message: 'That classifier prompt is too long. Keep it under 2,000 characters.',
    });
    return;
  }
  try {
    const current = await getTenant(tenantId);
    if (!current) {
      sendError(res, 404, { code: 'not-found', message: 'This workspace no longer exists.' });
      return;
    }
    await updateSettings(tenantId, {
      classifier: { ...current.settings.classifier, prompt: prompt || null },
    });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't save your classifier prompt. Please try again in a moment.",
      internal: e,
    });
  }
});

onboardingRouter.post('/api/complete', requireAdmin, csrfGuard, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  try {
    await markOnboardingComplete(tenantId);
    auditFireAndForget(tenantId, res.locals.adminEmail ?? null, 'onboarding.completed', {});
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't finalize onboarding. Please try again in a moment.",
      internal: e,
    });
  }
});

// Abandon the current in-progress workspace and start fresh with a different
// Google account. Soft-deletes the tenant (cleanup cron hard-deletes after
// 30 days) and clears the admin session cookie so the user lands on the
// login screen. Only allowed while onboarding is incomplete — once a tenant
// is in production we don't want a click to silently nuke it.
onboardingRouter.post('/api/reset', requireAdmin, csrfGuard, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  try {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      sendError(res, 404, { code: 'not-found', message: 'This workspace no longer exists.' });
      return;
    }
    if (tenant.onboardingCompletedAt) {
      sendError(res, 400, {
        code: 'conflict',
        message:
          'This workspace is already live. To remove it, go to Settings → Danger zone instead of "Start over".',
      });
      return;
    }
    await softDeleteTenant(tenantId);
    auditFireAndForget(tenantId, res.locals.adminEmail ?? null, 'tenant.soft_deleted', {
      reason: 'onboarding-start-over',
    });
    clearSession(res);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't reset onboarding. Please try again in a moment.",
      internal: e,
    });
  }
});
