import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  requireAdmin,
  checkPassword,
  issueSessionForPassword,
  clearSession,
  getSessionEmail,
} from '../lib/auth.js';
import { ingestPdf, deleteDocument, listDocuments } from '../kb/ingest.js';
import type { Tenant } from '../tenant/store.js';
import { db } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

export const adminRouter: Router = Router();

adminRouter.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ============================================================
// Login page
// ============================================================
adminRouter.get('/login', async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'login.html'), 'utf-8');
  // Google sign-in is always enabled in SaaS mode (anyone can sign up)
  res.type('html').send(html.replace('<!--GOOGLE_SIGNIN_ENABLED-->', 'true'));
});

adminRouter.post('/login', loginLimiter, (req, res) => {
  const pwd = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!checkPassword(pwd)) {
    res.status(401).type('html').send(
      `<div style="font-family:system-ui;padding:40px;max-width:520px;margin:60px auto;background:#fff;border:1px solid #fca5a5;border-radius:12px"><h2 style="margin-top:0;color:#dc2626">Wrong password</h2><p><a href="/admin/login" style="color:#4f46e5">Try again</a></p></div>`,
    );
    return;
  }
  issueSessionForPassword(res);
  res.redirect('/admin');
});

adminRouter.post('/auth/logout', requireAdmin, (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

adminRouter.get('/auth/logout', (_req, res) => {
  clearSession(res);
  res.redirect('/admin/login');
});

// ============================================================
// Dashboard page (forces onboarding if incomplete)
// ============================================================
adminRouter.get('/', requireAdmin, async (_req, res) => {
  const tenant = res.locals.tenant as Tenant | undefined;
  if (tenant && !tenant.onboardingCompletedAt) {
    res.redirect('/admin/onboarding');
    return;
  }
  const html = await readFile(path.join(__dirname, '..', 'ui', 'admin.html'), 'utf-8');
  res.type('html').send(html);
});

// ============================================================
// JSON API — every endpoint scoped by res.locals.tenantId
// ============================================================
adminRouter.get('/api/documents', requireAdmin, async (_req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    res.status(400).json({ error: 'no tenant context — password sessions cannot list docs' });
    return;
  }
  res.json(await listDocuments(tenantId));
});

adminRouter.post('/api/documents', requireAdmin, upload.single('file'), async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  const tenant = res.locals.tenant as Tenant | undefined;
  const adminEmail = (res.locals.adminEmail as string | null) ?? null;
  if (!tenantId || !tenant) {
    res.status(400).json({ error: 'no tenant context — sign in with Google to upload' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    res.status(400).json({ error: 'only PDF files supported' });
    return;
  }
  try {
    const result = await ingestPdf(
      { tenantId, settings: tenant.settings, actorEmail: adminEmail },
      req.file.originalname,
      req.file.buffer,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

adminRouter.delete('/api/documents/:id', requireAdmin, async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  const tenant = res.locals.tenant as Tenant | undefined;
  const adminEmail = (res.locals.adminEmail as string | null) ?? null;
  if (!tenantId || !tenant) {
    res.status(400).json({ error: 'no tenant context' });
    return;
  }
  const id = req.params.id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  try {
    await deleteDocument(
      { tenantId, settings: tenant.settings, actorEmail: adminEmail },
      id,
    );
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

adminRouter.get('/api/messages', requireAdmin, async (_req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    res.status(400).json({ error: 'no tenant context' });
    return;
  }
  const { data, error } = await db()
    .from('messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('received_at', { ascending: false })
    .limit(100);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

adminRouter.get('/api/status', requireAdmin, async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  let gmail: { email: string; updated_at: string } | null = null;
  if (tenantId) {
    const { data } = await db()
      .from('oauth_tokens')
      .select('email, updated_at')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    gmail = data ?? null;
  }
  const tenant = res.locals.tenant as Tenant | undefined;
  res.json({
    gmail,
    admin: { email: getSessionEmail(req) },
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          onboardingCompletedAt: tenant.onboardingCompletedAt,
          paused: tenant.settings.polling.paused,
        }
      : null,
  });
});

adminRouter.get('/api/stats', requireAdmin, async (_req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    res.json({ documents: 0, repliesSent7d: 0, repliesSkipped7d: 0, lastEmailAt: null });
    return;
  }
  const supabase = db();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [docs, sent, skipped, lastMsg] = await Promise.all([
    supabase
      .from('kb_documents')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'ingested'),
    supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('reply_status', 'sent')
      .gte('received_at', sevenDaysAgo),
    supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('reply_status', 'skipped')
      .gte('received_at', sevenDaysAgo),
    supabase
      .from('messages')
      .select('received_at')
      .eq('tenant_id', tenantId)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  res.json({
    documents: docs.count ?? 0,
    repliesSent7d: sent.count ?? 0,
    repliesSkipped7d: skipped.count ?? 0,
    lastEmailAt: lastMsg.data?.received_at ?? null,
  });
});
