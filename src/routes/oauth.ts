import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { google } from 'googleapis';
import {
  MAILBOX_SCOPES,
  getOAuthClient,
  saveTokensForTenant,
  buildMailboxAuthUrl,
  buildSigninAuthUrl,
} from '../providers/gmail.js';
import { requireAdmin, issueSessionForEmail } from '../lib/auth.js';
import { findTenantForEmail, provisionTenant } from '../tenant/store.js';
import { audit } from '../tenant/audit.js';
import { logger } from '../lib/logger.js';
import { db } from '../db/client.js';

export const oauthRouter: Router = Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Mailbox connect flow — admin must be signed in; state encodes their tenant id
oauthRouter.get('/start', requireAdmin, (_req, res) => {
  const tenantId = res.locals.tenantId;
  if (!tenantId) {
    res
      .status(400)
      .type('html')
      .send('<p>You must be signed in to a workspace before connecting a mailbox.</p>');
    return;
  }
  res.redirect(buildMailboxAuthUrl(tenantId));
});

// Anti-abuse: 5 signin starts per IP per hour. Stops bots from creating
// throwaway tenants en masse, which would each burn the shared OpenRouter
// key on classifier + risk calls before being caught by the spend cap.
const signinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message:
    'Too many sign-in attempts from this IP. Try again in an hour or contact support if this is a mistake.',
});

// Admin sign-in flow — public, auto-provisions a tenant on first signin
oauthRouter.get('/signin', signinLimiter, (_req, res) => {
  res.redirect(buildSigninAuthUrl());
});

// Unified callback — routes on `state`
oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const stateRaw = typeof req.query.state === 'string' ? req.query.state : '';
  const [stateKind, stateTenantId] = stateRaw.split(':');
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

    if (stateKind === 'login') {
      let found = await findTenantForEmail(email);
      if (!found) {
        const tenant = await provisionTenant(email);
        await audit(tenant.id, email, 'tenant.provisioned', { via: 'google-signin' });
        logger.info({ email, tenantId: tenant.id }, 'auto-provisioned new tenant');
        issueSessionForEmail(res, email, tenant.id);
        await audit(tenant.id, email, 'auth.signin', { method: 'google' });
        res.redirect('/admin/onboarding');
        return;
      }
      await audit(found.tenant.id, email, 'auth.signin', { method: 'google' });
      issueSessionForEmail(res, email, found.tenant.id);
      res.redirect(found.tenant.onboardingCompletedAt ? '/admin' : '/admin/onboarding');
      return;
    }

    // Mailbox connect flow — state was "mailbox:<tenantId>"
    if (stateKind === 'mailbox') {
      if (!stateTenantId) {
        res
          .status(400)
          .type('html')
          .send('<p>Mailbox-connect state missing tenant. Restart the flow from /admin.</p>');
        return;
      }
      if (!tokens.refresh_token) {
        res
          .status(400)
          .type('html')
          .send(
            '<p>Missing refresh token. Revoke previous access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and retry.</p>',
          );
        return;
      }
      await saveTokensForTenant(
        stateTenantId,
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date ?? Date.now() + 3500_000,
          scope: tokens.scope ?? MAILBOX_SCOPES.join(' '),
        },
        email,
      );
      await audit(stateTenantId, email, 'gmail.connected', {});
      logger.info({ email, tenantId: stateTenantId }, 'gmail mailbox connected');

      // Look up the tenant's onboarding state so we know where to send them.
      const { data: tenantRow } = await db()
        .from('tenants')
        .select('onboarding_completed_at')
        .eq('id', stateTenantId)
        .maybeSingle();
      const onboarded = !!(tenantRow as { onboarding_completed_at: string | null } | null)
        ?.onboarding_completed_at;
      res.redirect(onboarded ? '/admin#settings' : '/admin/onboarding#mailbox-return');
      return;
    }

    res.status(400).type('html').send(`<p>Unknown OAuth state: ${escapeHtml(stateRaw)}</p>`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, state: stateRaw }, 'oauth callback failed');
    res.status(500).type('html').send(`<p>OAuth failed: ${escapeHtml(msg)}</p>`);
  }
});
