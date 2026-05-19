import { Router } from 'express';
import { google } from 'googleapis';
import { SCOPES, getOAuthClient, saveTokens } from '../providers/gmail.js';
import { requireAdmin } from '../lib/auth.js';
import { logger } from '../lib/logger.js';

export const oauthRouter: Router = Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Step 1: redirect to Google consent screen
oauthRouter.get('/start', requireAdmin, (_req, res) => {
  const client = getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.redirect(url);
});

// Step 2: Google redirects back here with ?code=...
oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      res
        .status(400)
        .send(
          'Missing tokens in response. Try revoking access at https://myaccount.google.com/permissions and retrying.',
        );
      return;
    }

    // Fetch the authorized email
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const profile = await oauth2.userinfo.get();
    const email = profile.data.email ?? 'unknown';

    await saveTokens(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date ?? Date.now() + 3500_000,
        scope: tokens.scope ?? SCOPES.join(' '),
      },
      email,
    );
    logger.info({ email }, 'gmail oauth connected');
    const safeEmail = escapeHtml(email);
    res.send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Gmail connected for ${safeEmail}</h2><p><a href="/admin">Go to admin</a></p></body></html>`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'oauth callback failed');
    res.status(500).send(`OAuth failed: ${msg}`);
  }
});
