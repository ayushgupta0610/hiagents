import { Router } from 'express';
import { google } from 'googleapis';
import {
  MAILBOX_SCOPES,
  getOAuthClient,
  saveTokens,
  buildMailboxAuthUrl,
  buildSigninAuthUrl,
} from '../providers/gmail.js';
import { requireAdmin, isAdminEmail, issueSessionForEmail, adminEmails } from '../lib/auth.js';
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

// ============================================================
// Mailbox connect flow (sensitive Gmail scopes — admin-only)
// ============================================================
oauthRouter.get('/start', requireAdmin, (_req, res) => {
  res.redirect(buildMailboxAuthUrl());
});

// ============================================================
// Admin sign-in flow (lightweight openid email profile scopes)
// Public start endpoint; we gate by ADMIN_EMAILS whitelist in the callback.
// ============================================================
oauthRouter.get('/signin', (_req, res) => {
  if (adminEmails().length === 0) {
    res
      .status(503)
      .type('html')
      .send(
        `<div style="font-family:system-ui;padding:40px;max-width:520px;margin:60px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><h2 style="margin-top:0">Sign-in is not configured</h2><p style="color:#666;line-height:1.5">The administrator has not set <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">ADMIN_EMAILS</code> in this deployment. Until they do, only password sign-in works.</p><p><a href="/admin/login" style="color:#4f46e5">Back to login</a></p></div>`,
      );
    return;
  }
  res.redirect(buildSigninAuthUrl());
});

// ============================================================
// Unified callback — routes on `state` (login | mailbox)
// ============================================================
oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : 'mailbox';
  if (!code) {
    res.status(400).type('html').send('<p>Missing authorization code.</p>');
    return;
  }
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      res.status(400).type('html').send('<p>Missing access token in OAuth response.</p>');
      return;
    }

    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const profile = await oauth2.userinfo.get();
    const email = (profile.data.email ?? '').toLowerCase();
    if (!email) {
      res.status(400).type('html').send('<p>Google did not return an email address.</p>');
      return;
    }

    if (state === 'login') {
      if (!isAdminEmail(email)) {
        logger.warn({ email }, 'sign-in denied: not in ADMIN_EMAILS');
        res
          .status(403)
          .type('html')
          .send(
            `<div style="font-family:system-ui;padding:40px;max-width:520px;margin:60px auto;background:#fff;border:1px solid #fca5a5;border-radius:12px"><h2 style="margin-top:0;color:#dc2626">Access denied</h2><p style="color:#444;line-height:1.5"><strong>${escapeHtml(email)}</strong> is not authorized to sign in to this dashboard.</p><p style="color:#666;line-height:1.5">If you should have access, ask the administrator to add this email to <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">ADMIN_EMAILS</code> in the deployment's <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">.env</code>.</p><p><a href="/admin/login" style="color:#4f46e5">Back to login</a></p></div>`,
          );
        return;
      }
      issueSessionForEmail(res, email);
      logger.info({ email }, 'admin signed in via google');
      res.redirect('/admin');
      return;
    }

    // Mailbox connect flow (default)
    if (!tokens.refresh_token) {
      res
        .status(400)
        .type('html')
        .send(
          '<p>Missing refresh token in OAuth response. Revoke previous access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and retry.</p>',
        );
      return;
    }

    await saveTokens(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date ?? Date.now() + 3500_000,
        scope: tokens.scope ?? MAILBOX_SCOPES.join(' '),
      },
      email,
    );
    logger.info({ email }, 'gmail mailbox connected');
    const safeEmail = escapeHtml(email);
    res
      .type('html')
      .send(
        `<div style="font-family:system-ui;padding:40px;max-width:520px;margin:60px auto;background:#fff;border:1px solid #86efac;border-radius:12px"><h2 style="margin-top:0;color:#16a34a">Gmail connected</h2><p style="color:#444">The bot will poll <strong>${safeEmail}</strong> and reply to client queries.</p><p><a href="/admin" style="color:#4f46e5;font-weight:500">Go to admin →</a></p></div>`,
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, state }, 'oauth callback failed');
    res.status(500).type('html').send(`<p>OAuth failed: ${escapeHtml(msg)}</p>`);
  }
});
