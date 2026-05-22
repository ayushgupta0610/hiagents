import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, csrfGuard } from '../lib/auth.js';
import { updateSettings, getTenant, softDeleteTenant } from '../tenant/store.js';
import { auditFireAndForget } from '../tenant/audit.js';
import { summarizeUsage } from '../tenant/usage.js';
import { sendError } from '../lib/errors.js';
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
    sendError(res, 400, {
      code: 'tenant-required',
      message: 'Sign in with Google to access workspace settings.',
    });
    return null;
  }
  return tenantId;
}

settingsRouter.get('/', requireAdmin, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    sendError(res, 404, { code: 'not-found', message: 'This workspace no longer exists.' });
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

// Zod schema for the PUT /settings/ body. `strict()` rejects unknown keys so
// a tenant can't smuggle extra JSONB into their settings column (e.g. a
// `superAdmin: true` field that some future code path might check). Every
// numeric range matches the assumptions the rest of the codebase makes
// about these values; sub-objects are .partial() because UI saves patch
// individual sections (persona, models, polling, etc.) one at a time.
const personaPatchSchema = z
  .object({
    signature: z.string().max(200),
    tone: z.string().max(200),
    companyDescription: z.string().max(1000),
  })
  .strict()
  .partial();

const classifierPatchSchema = z
  .object({
    model: z.enum(ALLOWED_CLASSIFIER_MODELS),
    prompt: z.string().max(2000).nullable(),
  })
  .strict()
  .partial();

const replyPatchSchema = z
  .object({
    model: z.enum(ALLOWED_REPLY_MODELS),
  })
  .strict()
  .partial();

const retrievalPatchSchema = z
  .object({
    similarityThreshold: z.number().min(0).max(1),
    topK: z.number().int().min(1).max(50),
  })
  .strict()
  .partial();

const pollingPatchSchema = z
  .object({
    intervalSeconds: z.number().int().min(30).max(3600),
    autoSend: z.boolean(),
    paused: z.boolean(),
  })
  .strict()
  .partial();

// limits is intentionally NOT exposed in the patch schema — those caps
// (daily email cap, spend cap, etc.) are operator-controlled to keep
// tenants from raising their own ceilings via the API. If we ever ship a
// "billing tier" UI, that should write to a separate path.
const settingsPatchSchema = z
  .object({
    persona: personaPatchSchema,
    classifier: classifierPatchSchema,
    reply: replyPatchSchema,
    retrieval: retrievalPatchSchema,
    polling: pollingPatchSchema,
  })
  .strict()
  .partial();

settingsRouter.put('/', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const parsed = settingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    // Surface only the first user-visible problem to keep the toast short.
    // Full details go to logs for debugging.
    const first = parsed.error.issues[0];
    const fieldPath = first ? first.path.join('.') : '(unknown)';
    sendError(res, 400, {
      code: 'validation-failed',
      message: `That setting isn't valid: ${fieldPath} — ${first?.message ?? 'unknown error'}.`,
      internal: parsed.error.issues,
      details: { fields: parsed.error.issues.map((i) => i.path.join('.')) },
    });
    return;
  }
  try {
    const updated = await updateSettings(tenantId, parsed.data as Partial<TenantSettings>);
    auditFireAndForget(tenantId, res.locals.adminEmail ?? null, 'settings.updated', {
      keys: Object.keys(parsed.data),
    });
    res.json({ settings: updated });
  } catch (e) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't save those settings. Please try again in a moment.",
      internal: e,
    });
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
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't load your usage summary. Please try again in a moment.",
      internal: e,
    });
  }
});

settingsRouter.post('/account/delete', requireAdmin, csrfGuard, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  try {
    await softDeleteTenant(tenantId);
    auditFireAndForget(tenantId, res.locals.adminEmail ?? null, 'tenant.soft_deleted', {});
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't delete this workspace. Please try again or contact support.",
      internal: e,
    });
  }
});
