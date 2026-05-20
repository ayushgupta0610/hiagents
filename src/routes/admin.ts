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
  adminEmails,
} from '../lib/auth.js';
import { ingestPdf, deleteDocument, listDocuments } from '../kb/ingest.js';
import { db } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

export const adminRouter: Router = Router();

// Prevent any browser/proxy/service-worker caching of API responses
adminRouter.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ============================================================
// Login page (serve login.html)
// ============================================================
adminRouter.get('/login', async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'login.html'), 'utf-8');
  const googleSignInEnabled = adminEmails().length > 0;
  // Toggle Google sign-in visibility purely on the server side so the rendered HTML
  // doesn't need to fetch /admin/api/auth-config separately
  res
    .type('html')
    .send(html.replace('<!--GOOGLE_SIGNIN_ENABLED-->', googleSignInEnabled ? 'true' : 'false'));
});

// Password fallback login
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
// Dashboard page
// ============================================================
adminRouter.get('/', requireAdmin, async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'admin.html'), 'utf-8');
  res.type('html').send(html);
});

// ============================================================
// JSON API
// ============================================================
adminRouter.get('/api/documents', requireAdmin, async (_req, res) => {
  res.json(await listDocuments());
});

adminRouter.post('/api/documents', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    res.status(400).json({ error: 'only PDF files supported' });
    return;
  }
  try {
    const result = await ingestPdf(req.file.originalname, req.file.buffer);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

adminRouter.delete('/api/documents/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  try {
    await deleteDocument(id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

adminRouter.get('/api/messages', requireAdmin, async (_req, res) => {
  const { data, error } = await db()
    .from('messages')
    .select('*')
    .order('received_at', { ascending: false })
    .limit(100);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

adminRouter.get('/api/status', requireAdmin, async (req, res) => {
  const { data: oauth } = await db()
    .from('oauth_tokens')
    .select('email, updated_at')
    .eq('id', 1)
    .maybeSingle();
  res.json({
    gmail: oauth ?? null,
    admin: { email: getSessionEmail(req) },
    googleSigninEnabled: adminEmails().length > 0,
  });
});

adminRouter.get('/api/stats', requireAdmin, async (_req, res) => {
  const supabase = db();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [docs, chunks, sent, skipped, lastMsg] = await Promise.all([
    supabase.from('kb_documents').select('*', { count: 'exact', head: true }).eq('status', 'ingested'),
    supabase.from('kb_chunks').select('*', { count: 'exact', head: true }),
    supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('reply_status', 'sent')
      .gte('received_at', sevenDaysAgo),
    supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('reply_status', 'skipped')
      .gte('received_at', sevenDaysAgo),
    supabase
      .from('messages')
      .select('received_at')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  res.json({
    documents: docs.count ?? 0,
    chunks: chunks.count ?? 0,
    repliesSent7d: sent.count ?? 0,
    repliesSkipped7d: skipped.count ?? 0,
    lastEmailAt: lastMsg.data?.received_at ?? null,
  });
});
