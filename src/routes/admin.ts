import { Router } from 'express';
import multer from 'multer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin, clearSession, getSessionEmail, csrfGuard, issueCsrfToken } from '../lib/auth.js';
import { sendError } from '../lib/errors.js';
import { ingestPdf, deleteDocument, listDocuments } from '../kb/ingest.js';
import { auditFireAndForget } from '../tenant/audit.js';
import type { Tenant } from '../tenant/store.js';
import { db } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export const adminRouter: Router = Router();

adminRouter.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ============================================================
// Login page (Google sign-in only — no password fallback in SaaS mode)
// ============================================================
adminRouter.get('/login', async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'login.html'), 'utf-8');
  res.type('html').send(html);
});

// Logout is POST-only to prevent CSRF (image-tag forced-logout). Requires
// a valid CSRF token from the dashboard, which is set when the page renders.
adminRouter.post('/auth/logout', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  const adminEmail = (res.locals.adminEmail as string | null) ?? null;
  if (tenantId) {
    auditFireAndForget(tenantId, adminEmail, 'auth.signout', { ip: req.ip });
  }
  clearSession(res);
  res.json({ ok: true });
});

// ============================================================
// Dashboard page (forces onboarding if incomplete). Issues a CSRF token
// cookie that the page's JS reads and echoes back via X-CSRF-Token header
// on any state-changing API call.
// ============================================================
adminRouter.get('/', requireAdmin, async (_req, res) => {
  const tenant = res.locals.tenant as Tenant | undefined;
  if (tenant && !tenant.onboardingCompletedAt) {
    res.redirect('/admin/onboarding');
    return;
  }
  issueCsrfToken(res);
  const html = await readFile(path.join(__dirname, '..', 'ui', 'admin.html'), 'utf-8');
  res.type('html').send(html);
});

// ============================================================
// JSON API — every endpoint scoped by res.locals.tenantId
// ============================================================
adminRouter.get('/api/documents', requireAdmin, async (_req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    sendError(res, 400, {
      code: 'tenant-required',
      message: 'Sign in with Google to see your knowledge base.',
    });
    return;
  }
  res.json(await listDocuments(tenantId));
});

adminRouter.post('/api/documents', requireAdmin, csrfGuard, upload.single('file'), async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  const tenant = res.locals.tenant as Tenant | undefined;
  const adminEmail = (res.locals.adminEmail as string | null) ?? null;
  if (!tenantId || !tenant) {
    sendError(res, 400, {
      code: 'tenant-required',
      message: 'Sign in with Google to upload documents.',
    });
    return;
  }
  if (!req.file) {
    sendError(res, 400, {
      code: 'validation-failed',
      message: 'No file was attached. Choose a PDF and try again.',
    });
    return;
  }
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    sendError(res, 400, {
      code: 'validation-failed',
      message: 'Only PDF files are supported. Convert your document to PDF and upload again.',
    });
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
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't ingest that PDF. Try a different file, or contact support if it keeps failing.",
      internal: err,
    });
  }
});

adminRouter.delete('/api/documents/:id', requireAdmin, csrfGuard, async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  const tenant = res.locals.tenant as Tenant | undefined;
  const adminEmail = (res.locals.adminEmail as string | null) ?? null;
  if (!tenantId || !tenant) {
    sendError(res, 400, {
      code: 'tenant-required',
      message: 'Sign in with Google to manage your knowledge base.',
    });
    return;
  }
  const id = req.params.id;
  if (typeof id !== 'string' || !id) {
    sendError(res, 400, {
      code: 'validation-failed',
      message: 'Missing the document id. Refresh the page and try again.',
    });
    return;
  }
  try {
    await deleteDocument(
      { tenantId, settings: tenant.settings, actorEmail: adminEmail },
      id,
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't delete that document. Please try again in a moment.",
      internal: err,
    });
  }
});

// Activity feed — cursor-paginated by received_at (descending). The UI
// loads the latest PAGE_SIZE on first render, then calls again with
// ?before=<oldest-loaded-received_at-iso> to fetch the next page.
//
// Response shape: { items: Message[], hasMore: boolean, nextBefore: iso|null }
//
// We fetch PAGE_SIZE+1 rows and trim the extra; hasMore is true if that
// extra row existed, so the UI can decide whether to render a "Load older"
// button. nextBefore is the received_at of the last *returned* row, ready
// to be sent back as the next ?before value.
//
// Backward compat: callers that just GET /api/messages (no params, no
// envelope expectation) get back the items array directly when the
// `?paginate=1` query param is absent. The admin UI sends paginate=1.
const ACTIVITY_PAGE_SIZE = 100;

adminRouter.get('/api/messages', requireAdmin, async (req, res) => {
  const tenantId = res.locals.tenantId as string | null;
  if (!tenantId) {
    sendError(res, 400, {
      code: 'tenant-required',
      message: 'Sign in with Google to see message activity.',
    });
    return;
  }

  const before = typeof req.query.before === 'string' ? req.query.before : null;
  const paginate = req.query.paginate === '1';

  let query = db()
    .from('messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('received_at', { ascending: false })
    .limit(ACTIVITY_PAGE_SIZE + 1);

  // Defensive parse so a malformed ?before doesn't blow up the query —
  // Supabase would reject it with a 500. Treat as "no cursor".
  if (before && !Number.isNaN(Date.parse(before))) {
    query = query.lt('received_at', before);
  }

  const { data, error } = await query;
  if (error) {
    sendError(res, 500, {
      code: 'internal-error',
      message: "We couldn't load recent activity. Please try again in a moment.",
      internal: error,
    });
    return;
  }

  const rows = (data ?? []) as Array<{ received_at: string }>;
  const hasMore = rows.length > ACTIVITY_PAGE_SIZE;
  const items = hasMore ? rows.slice(0, ACTIVITY_PAGE_SIZE) : rows;
  const nextBefore = hasMore ? items[items.length - 1]?.received_at ?? null : null;

  if (paginate) {
    res.json({ items, hasMore, nextBefore });
  } else {
    res.json(items);
  }
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
