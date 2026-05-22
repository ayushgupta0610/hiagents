import { Router } from 'express';
import { requireAdmin, csrfGuard } from '../lib/auth.js';
import { updateSettings, getTenant, softDeleteTenant } from '../tenant/store.js';
import { audit } from '../tenant/audit.js';
import { summarizeUsage } from '../tenant/usage.js';
import {
  ALLOWED_REPLY_MODELS,
  ALLOWED_CLASSIFIER_MODELS,
  defaultTenantSettings,
  type TenantSettings,
} from '../tenant/types.js';

export const settingsRouter: Router = Router();

settingsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

function requireTenant(res: import('express').Response): string | null {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    res.status(400).json({ error: 'no tenant context — sign in with Google to access settings' });
    return null;
  }
  return tenantId;
}

settingsRouter.get('/', requireAdmin, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    res.status(404).json({ error: 'tenant not found' });
    return;
  }
  res.json({
    settings: tenant.settings,
    allowed: {
      replyModels: ALLOWED_REPLY_MODELS,
      classifierModels: ALLOWED_CLASSIFIER_MODELS,
    },
    defaults: defaultTenantSettings(),
  });
});

type SettingsPatch = Partial<TenantSettings>;

function validatePatch(patch: SettingsPatch): string | null {
  if (patch.reply && !ALLOWED_REPLY_MODELS.includes(patch.reply.model as never)) {
    return `Invalid reply model: ${patch.reply.model}. Allowed: ${ALLOWED_REPLY_MODELS.join(', ')}`;
  }
  if (
    patch.classifier &&
    patch.classifier.model &&
    !ALLOWED_CLASSIFIER_MODELS.includes(patch.classifier.model as never)
  ) {
    return `Invalid classifier model: ${patch.classifier.model}. Allowed: ${ALLOWED_CLASSIFIER_MODELS.join(', ')}`;
  }
  if (patch.classifier?.prompt && patch.classifier.prompt.length > 2000) {
    return 'Classifier prompt too long (max 2000 chars).';
  }
  if (patch.retrieval) {
    if (
      patch.retrieval.similarityThreshold != null &&
      (patch.retrieval.similarityThreshold < 0 || patch.retrieval.similarityThreshold > 1)
    ) {
      return 'similarityThreshold must be in [0, 1]';
    }
    if (
      patch.retrieval.topK != null &&
      (patch.retrieval.topK < 1 || patch.retrieval.topK > 50)
    ) {
      return 'topK must be in [1, 50]';
    }
  }
  if (patch.polling) {
    if (
      patch.polling.intervalSeconds != null &&
      (patch.polling.intervalSeconds < 30 || patch.polling.intervalSeconds > 3600)
    ) {
      return 'polling.intervalSeconds must be in [30, 3600]';
    }
  }
  return null;
}

settingsRouter.put('/', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const patch = (req.body ?? {}) as SettingsPatch;
  const err = validatePatch(patch);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  try {
    const updated = await updateSettings(tenantId, patch);
    await audit(tenantId, res.locals.adminEmail ?? null, 'settings.updated', {
      keys: Object.keys(patch),
    });
    res.json({ settings: updated });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

settingsRouter.get('/usage', requireAdmin, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const summary = await summarizeUsage(tenantId, since);
    res.json({ since, ...summary });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

settingsRouter.post('/account/delete', requireAdmin, csrfGuard, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  try {
    await softDeleteTenant(tenantId);
    await audit(tenantId, res.locals.adminEmail ?? null, 'tenant.soft_deleted', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
