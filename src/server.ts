import express from 'express';
import cookieParser from 'cookie-parser';
import { env } from './config.js';
import { logger } from './lib/logger.js';
import { sendUnhandled, sendError } from './lib/errors.js';
import { healthRouter } from './routes/health.js';
import { oauthRouter } from './routes/oauth.js';
import { adminRouter } from './routes/admin.js';
import { settingsRouter } from './routes/settings.js';
import { onboardingRouter } from './routes/onboarding.js';
import { startPoller } from './workers/poller.js';
import { startCleanupCron } from './workers/cleanup.js';

const app = express();

// Security headers on every response. CSP keeps 'unsafe-inline' for style/script
// because the admin UI uses inline <style>/<script> blocks; nonce-based tightening
// is a separate hardening pass. Google Fonts is explicitly allowlisted.
app.use((_req, res, next) => {
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// 256kb JSON cap limits DoS surface from oversize bodies. Multer (POST
// /admin/api/documents) keeps its own 25 MB cap for PDF uploads.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());

app.use('/health', healthRouter);
app.use('/oauth', oauthRouter);
app.use('/admin/api/settings', settingsRouter);
app.use('/admin/onboarding', onboardingRouter);
app.use('/admin', adminRouter);

app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// JSON parse errors from express.json() throw before any route runs — turn
// them into the same envelope rather than the default HTML page.
const errorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
  const e = err as Error & { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    sendError(res, 413, {
      code: 'payload-too-large',
      message: 'That request was too large. PDF uploads have a separate 25 MB limit on /admin/api/documents.',
      internal: e,
    });
    return;
  }
  if (e?.type === 'entity.parse.failed' || /JSON/i.test(e?.message ?? '')) {
    sendError(res, 400, {
      code: 'validation-failed',
      message: "We couldn't read the request body. Please refresh the page and try again.",
      internal: e,
    });
    return;
  }
  // Last-resort catch-all. Logs the full stack server-side; client gets a
  // friendly generic message via sendUnhandled.
  logger.error({ err: e?.message, path: req.path, method: req.method }, 'unhandled error');
  sendUnhandled(res, e);
};
app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, baseUrl: env.BASE_URL }, 'inbox-ai server listening');
  startPoller();
  startCleanupCron();
});
