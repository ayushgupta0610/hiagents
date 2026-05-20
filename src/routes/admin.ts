import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin, checkPassword, issueSessionCookie } from '../lib/auth.js';
import { ingestPdf, deleteDocument, listDocuments } from '../kb/ingest.js';
import { db } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per IP per window
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

adminRouter.get('/login', (_req, res) => {
  res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;max-width:400px;margin:auto">
    <h2>inbox-ai admin</h2>
    <form method="POST" action="/admin/login">
      <input name="password" type="password" placeholder="Admin password" style="width:100%;padding:8px;margin:8px 0" required>
      <button type="submit" style="padding:8px 16px">Log in</button>
    </form>
  </body></html>`);
});

adminRouter.post('/login', loginLimiter, (req, res) => {
  const pwd = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!checkPassword(pwd)) {
    res.status(401).type('html').send('<p>Wrong password. <a href="/admin/login">Try again</a></p>');
    return;
  }
  issueSessionCookie(res);
  res.redirect('/admin');
});

adminRouter.get('/', requireAdmin, async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'admin.html'), 'utf-8');
  res.type('html').send(html);
});

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

adminRouter.get('/api/status', requireAdmin, async (_req, res) => {
  const { data: oauth } = await db().from('oauth_tokens').select('email, updated_at').eq('id', 1).maybeSingle();
  res.json({ gmail: oauth ?? null });
});
