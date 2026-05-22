import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { google } from 'googleapis';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import {
  MAILBOX_SCOPES,
  getOAuthClient,
  saveTokensForTenant,
  buildMailboxAuthUrl,
  buildSigninAuthUrl,
  clearLabelCacheForTenant,
} from '../providers/gmail.js';
import { requireAdmin, issueSessionForEmail } from '../lib/auth.js';
import { findTenantForEmail, provisionTenant } from '../tenant/store.js';
import { auditFireAndForget } from '../tenant/audit.js';
import { logger } from '../lib/logger.js';
import { db } from '../db/client.js';
import { env } from '../config.js';

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
// OAuth state nonce — defends against forged-callback phishing
// ============================================================
//
// Without a nonce, anyone with a stolen Google authorization code (or a
// crafted callback URL) could trick a victim's browser into landing on
// /oauth/callback with attacker-controlled `state`. We bind every flow to
// a one-time nonce stored in a short-lived signed cookie:
//
//   1. /oauth/signin   → set cookie `oauth_state` = sign("login:" + nonce)
//                         redirect with state = "login:" + nonce
//   2. /oauth/start    → set cookie `oauth_state` = sign("mailbox:<tid>:" + nonce)
//                         redirect with state = "mailbox:" + tid + ":" + nonce
//   3. /oauth/callback → verify the state in the URL matches the cookie's
//                         signed value; reject if missing or mismatched.
//
// Cookie is sameSite=lax (so it travels on the top-level redirect back from
// Google, which is a same-site GET), httpOnly (JS can't read it), 10-min
// max-age (long enough for the user to complete the Google consent screen,
// short enough to limit the attack window).

const STATE_COOKIE = 'hiagents_oauth_state';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function signState(payload: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(`oauth:${payload}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function setStateCookie(res: import('express').Response, statePayload: string): void {
  const cookieValue = `${statePayload}.${signState(statePayload)}`;
  res.cookie(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: STATE_MAX_AGE_MS,
    path: '/oauth',
  });
}

function consumeStateCookie(req: import('express').Request, res: import('express').Response): string | null {
  const raw = req.cookies?.[STATE_COOKIE];
  // Always clear — single-use, even on failure.
  res.clearCookie(STATE_COOKIE, { path: '/oauth' });
  if (typeof raw !== 'string') return null;
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const payload = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);
  if (!safeEqual(sig, signState(payload))) return null;
  return payload;
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
  const nonce = randomBytes(16).toString('base64url');
  const statePayload = `mailbox:${tenantId}:${nonce}`;
  setStateCookie(res, statePayload);
  res.redirect(buildMailboxAuthUrl(statePayload));
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
  const nonce = randomBytes(16).toString('base64url');
  const statePayload = `login:${nonce}`;
  setStateCookie(res, statePayload);
  res.redirect(buildSigninAuthUrl(statePayload));
});

// Unified callback — routes on `state`. Verifies the state nonce against
// the signed cookie BEFORE doing anything with the code (so we never
// exchange a code for tokens for an unverified flow).
oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const stateRaw = typeof req.query.state === 'string' ? req.query.state : '';

  // 1. Verify state nonce matches the signed cookie we set when the flow began.
  const cookiePayload = consumeStateCookie(req, res);
  if (!cookiePayload || !stateRaw || !safeEqual(stateRaw, cookiePayload)) {
    logger.warn(
      { ip: req.ip, stateRaw, hadCookie: !!cookiePayload },
      'oauth callback rejected: state nonce mismatch',
    );
    res
      .status(400)
      .type('html')
      .send(
        '<p>This sign-in link is invalid or has expired. Please <a href="/admin/login">start the sign-in again</a> from the login page.</p>',
      );
    return;
  }

  const [stateKind, stateTenantOrNonce] = stateRaw.split(':');
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
        auditFireAndForget(tenant.id, email, 'tenant.provisioned', { via: 'google-signin' });
        logger.info({ email, tenantId: tenant.id }, 'auto-provisioned new tenant');
        issueSessionForEmail(res, email, tenant.id);
        auditFireAndForget(tenant.id, email, 'auth.signin', { method: 'google', ip: req.ip });
        res.redirect('/admin/onboarding');
        return;
      }
      auditFireAndForget(found.tenant.id, email, 'auth.signin', { method: 'google', ip: req.ip });
      issueSessionForEmail(res, email, found.tenant.id);
      res.redirect(found.tenant.onboardingCompletedAt ? '/admin' : '/admin/onboarding');
      return;
    }

    // Mailbox connect flow — state was "mailbox:<tenantId>:<nonce>"
    if (stateKind === 'mailbox') {
      const stateTenantId = stateTenantOrNonce;
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
      // If the user reconnected with a different Gmail, the cached label
      // ids from the previous mailbox are now stale — drop them so the
      // next applyLabel re-resolves against the new mailbox.
      clearLabelCacheForTenant(stateTenantId);
      auditFireAndForget(stateTenantId, email, 'gmail.connected', { ip: req.ip });
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
    logger.error({ err: msg, state: stateRaw, ip: req.ip }, 'oauth callback failed');
    res
      .status(500)
      .type('html')
      .send(
        '<p>We couldn\'t complete the sign-in. Please <a href="/admin/login">try again</a>. If this keeps happening, contact support.</p>',
      );
  }
});
