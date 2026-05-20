import express from 'express';
import cookieParser from 'cookie-parser';
import { env } from './config.js';
import { logger } from './lib/logger.js';
import { healthRouter } from './routes/health.js';
import { oauthRouter } from './routes/oauth.js';
import { adminRouter } from './routes/admin.js';
import { settingsRouter } from './routes/settings.js';
import { onboardingRouter } from './routes/onboarding.js';
import { startPoller } from './workers/poller.js';
import { startCleanupCron } from './workers/cleanup.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/health', healthRouter);
app.use('/oauth', oauthRouter);
app.use('/admin/api/settings', settingsRouter);
app.use('/admin/onboarding', onboardingRouter);
app.use('/admin', adminRouter);

app.get('/', (_req, res) => {
  res.redirect('/admin');
});

const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  const error = err as Error;
  logger.error({ err: error.message, stack: error.stack }, 'unhandled error');
  res.status(500).json({ error: 'internal error' });
};
app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, baseUrl: env.BASE_URL }, 'inbox-ai server listening');
  startPoller();
  startCleanupCron();
});
