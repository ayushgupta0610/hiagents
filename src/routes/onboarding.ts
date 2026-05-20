import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin } from '../lib/auth.js';
import { updateSettings, markOnboardingComplete, getTenant } from '../tenant/store.js';
import { audit } from '../tenant/audit.js';
import { db } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const onboardingRouter: Router = Router();

function requireTenant(res: import('express').Response): string | null {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    res.status(400).json({ error: 'sign in with Google to access onboarding' });
    return null;
  }
  return tenantId;
}

onboardingRouter.get('/', requireAdmin, async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'onboarding.html'), 'utf-8');
  res.type('html').send(html);
});

onboardingRouter.get('/api/state', requireAdmin, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    res.status(404).json({ error: 'tenant' });
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
      persona: !!tenant.settings.persona.companyDescription,
      kb: (docsCount ?? 0) > 0,
      // Classifier shows "done" only after the full wizard is complete — during the
      // wizard itself, it's the step the user is currently on (or hasn't reached yet),
      // so showing it as already-done was misleading the progress bar.
      classifier: !!tenant.onboardingCompletedAt,
      done: !!tenant.onboardingCompletedAt,
    },
  });
});

onboardingRouter.post('/api/welcome', requireAdmin, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) {
    res.status(400).json({ error: 'name required (1-80 chars)' });
    return;
  }
  const { error } = await db().from('tenants').update({ name }).eq('id', tenantId);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ ok: true });
});

onboardingRouter.post('/api/persona', requireAdmin, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const { signature, tone, companyDescription } = req.body ?? {};
  if (
    typeof signature !== 'string' ||
    typeof tone !== 'string' ||
    typeof companyDescription !== 'string'
  ) {
    res.status(400).json({ error: 'signature, tone, companyDescription required' });
    return;
  }
  try {
    await updateSettings(tenantId, {
      persona: {
        signature: signature.slice(0, 200),
        tone: tone.slice(0, 200),
        companyDescription: companyDescription.slice(0, 1000),
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

onboardingRouter.post('/api/classifier', requireAdmin, async (req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (prompt.length > 2000) {
    res.status(400).json({ error: 'prompt too long (max 2000)' });
    return;
  }
  try {
    const current = await getTenant(tenantId);
    if (!current) {
      res.status(404).json({ error: 'tenant not found' });
      return;
    }
    await updateSettings(tenantId, {
      classifier: { ...current.settings.classifier, prompt: prompt || null },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

onboardingRouter.post('/api/complete', requireAdmin, async (_req, res) => {
  const tenantId = requireTenant(res);
  if (!tenantId) return;
  try {
    await markOnboardingComplete(tenantId);
    await audit(tenantId, res.locals.adminEmail ?? null, 'onboarding.completed', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
