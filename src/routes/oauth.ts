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
// Styled error page for /oauth/* failures
// ============================================================
//
// Every OAuth failure (Google denied, state mismatch, missing scopes,
// upstream exception) used to render a bare `<p>...</p>` paragraph that
// looked like a server crash to the user — no styling, no explanation,
// no path forward. This helper renders the same dark-theme aesthetic as
// the login page so a denied user lands somewhere that looks intentional
// and tells them what to do next.
//
// `back` defaults to /admin/login since that's where the signin flow
// originates; the mailbox-connect flow overrides it to /admin.

interface OAuthErrorOpts {
  status?: number;
  title: string;
  message: string;
  hint?: string;
  backHref?: string;
  backText?: string;
}

function renderOAuthError(
  res: import('express').Response,
  opts: OAuthErrorOpts,
): void {
  const {
    status = 400,
    title,
    message,
    hint,
    backHref = '/admin/login',
    backText = '← Back to sign in',
  } = opts;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · hiagents</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
  :root {
    --ink: #07070a; --ink-soft: #0d0d12; --paper: #f7f5f0; --mute: #8a8780;
    --line: rgba(247,245,240,0.16); --amber: #e9b872;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--ink); color: var(--paper);
    min-height: 100vh; display: grid; place-items: center; padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 480px;
    background: var(--ink-soft); border: 1px solid var(--line);
    border-radius: 16px; padding: 36px 32px;
    box-shadow: 0 4px 30px rgba(0,0,0,0.3);
  }
  .icon {
    width: 44px; height: 44px; border-radius: 12px;
    background: rgba(233,184,114,0.12); border: 1px solid rgba(233,184,114,0.35);
    color: var(--amber); display: grid; place-items: center;
    margin: 0 0 20px; font-size: 20px;
  }
  h1 { margin: 0 0 10px; font-size: 22px; font-weight: 600; letter-spacing: -0.4px; }
  p { margin: 0 0 14px; color: var(--mute); font-size: 15px; line-height: 1.55; }
  p.hint {
    background: rgba(247,245,240,0.04); border: 1px solid var(--line);
    border-left: 3px solid var(--amber);
    padding: 12px 14px; border-radius: 8px;
    color: var(--paper); font-size: 13px;
  }
  a.back {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 22px; padding: 11px 18px;
    background: var(--paper); color: var(--ink);
    border-radius: 999px; text-decoration: none;
    font-size: 14px; font-weight: 500;
    transition: background 0.15s;
  }
  a.back:hover { background: var(--amber); }
  code {
    font-family: ui-monospace, SF Mono, Menlo, monospace;
    background: rgba(247,245,240,0.06); padding: 1px 5px;
    border-radius: 4px; font-size: 12px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon" aria-hidden="true">!</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    <a class="back" href="${escapeHtml(backHref)}">${escapeHtml(backText)}</a>
  </div>
</body>
</html>`;
  res.status(status).type('html').send(html);
}

// Google sends explicit error codes back to our callback when consent is
// denied, the user closes the chooser, the app is blocked by an admin
// policy, etc. Map the most common ones to actionable messages. Anything
// we don't recognise falls back to a generic "we couldn't complete the
// sign-in" with the raw code echoed (escaped) for debugging.
function explainGoogleError(code: string, description: string): { title: string; message: string; hint?: string } {
  switch (code) {
    case 'access_denied':
      return {
        title: "Google didn't let us in",
        message:
          "Either you cancelled the sign-in, or Google blocked your email from accessing this app.",
        hint:
          "If you saw an <strong>“Access blocked”</strong> screen, this app is currently in private testing and your Google account isn't on the test-users list yet. Reply to your invite email or contact <a href=\"mailto:hi@hiagents.digital\" style=\"color:var(--amber)\">hi@hiagents.digital</a> with the address you tried, and we'll add you within a day.",
      };
    case 'admin_policy_enforced':
      return {
        title: 'Your workspace admin blocked this app',
        message:
          "Google rejected the sign-in because your Google Workspace administrator hasn't approved third-party apps that need Gmail access.",
        hint:
          'Ask your IT / Workspace admin to allow <strong>hiagents</strong> in <em>Google Admin Console → Security → API controls → Manage third-party app access</em>.',
      };
    case 'consent_required':
    case 'interaction_required':
      return {
        title: 'Sign-in incomplete',
        message:
          "The Google sign-in screen closed before you finished granting access. Click the button below to try again.",
      };
    case 'invalid_scope':
    case 'invalid_request':
      return {
        title: 'Sign-in misconfigured',
        message:
          "Something on our OAuth setup looks wrong on Google's side. We've logged it and will look into it — try again in a few minutes, and if it keeps happening please reach out.",
      };
    default:
      return {
        title: 'Sign-in failed',
        message: `Google returned an error we don't recognise: <code>${escapeHtml(code)}</code>${description ? ` — ${escapeHtml(description)}` : ''}.`,
      };
  }
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
    renderOAuthError(res, {
      title: 'No workspace yet',
      message:
        "You need to be signed in to a workspace before connecting a mailbox. Head back to sign in and we'll provision one for you.",
      backHref: '/admin/login',
    });
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
  const errorCode = typeof req.query.error === 'string' ? req.query.error : null;
  const errorDescription =
    typeof req.query.error_description === 'string' ? req.query.error_description : '';

  // Figure out where the "Back" button should go based on the state kind
  // (best-effort — if the cookie is gone, the link in stateRaw still tells
  // us whether this was a signin or a mailbox-connect flow). Default to
  // /admin/login since signin is the more common path.
  const isMailboxFlow = stateRaw.startsWith('mailbox:');
  const backHref = isMailboxFlow ? '/admin' : '/admin/login';
  const backText = isMailboxFlow ? '← Back to dashboard' : '← Back to sign in';

  // 0. Google sent us back with an explicit error (denied, blocked,
  // user closed the chooser, etc). Render a friendly, actionable page
  // — this is the #1 path for "I tried to sign in and nothing happened".
  if (errorCode) {
    logger.warn(
      { ip: req.ip, errorCode, errorDescription, stateRaw },
      'oauth callback received explicit Google error',
    );
    // Still consume the state cookie so we don't leave it lingering.
    consumeStateCookie(req, res);
    const explained = explainGoogleError(errorCode, errorDescription);
    renderOAuthError(res, {
      status: 400,
      ...explained,
      backHref,
      backText,
    });
    return;
  }

  // 1. Verify state nonce matches the signed cookie we set when the flow began.
  const cookiePayload = consumeStateCookie(req, res);
  if (!cookiePayload || !stateRaw || !safeEqual(stateRaw, cookiePayload)) {
    logger.warn(
      { ip: req.ip, stateRaw, hadCookie: !!cookiePayload },
      'oauth callback rejected: state nonce mismatch',
    );
    renderOAuthError(res, {
      status: 400,
      title: 'Sign-in link expired',
      message:
        "This sign-in link is invalid or has expired (the page may have sat open for more than 10 minutes). Start over from the sign-in page.",
      backHref,
      backText,
    });
    return;
  }

  const [stateKind, stateTenantOrNonce] = stateRaw.split(':');
  if (!code) {
    renderOAuthError(res, {
      status: 400,
      title: 'Sign-in incomplete',
      message:
        "Google didn't send us an authorization code. This usually means the consent screen was closed before you finished — try again.",
      backHref,
      backText,
    });
    return;
  }
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      renderOAuthError(res, {
        status: 400,
        title: 'Sign-in failed',
        message:
          "Google didn't return an access token. This is rare — try signing in again. If it keeps happening, reach out and we'll dig in.",
        backHref,
        backText,
      });
      return;
    }

    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const profile = await oauth2.userinfo.get();
    const email = (profile.data.email ?? '').toLowerCase();
    if (!email) {
      renderOAuthError(res, {
        status: 400,
        title: 'Sign-in failed',
        message:
          "Google didn't return an email address for your account. Make sure you grant the email-address scope when prompted, then try again.",
        backHref,
        backText,
      });
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
        renderOAuthError(res, {
          status: 400,
          title: 'Mailbox-connect link is broken',
          message:
            "We can't tell which workspace this mailbox was meant for. Head back to the dashboard and click <strong>Connect Gmail</strong> again.",
          backHref: '/admin',
          backText: '← Back to dashboard',
        });
        return;
      }
      if (!tokens.refresh_token) {
        renderOAuthError(res, {
          status: 400,
          title: 'Google withheld the refresh token',
          message:
            "Google only returns a refresh token on the very first consent. To get a new one, revoke this app's access in your Google account, then try connecting again.",
          hint:
            'Visit <a href="https://myaccount.google.com/permissions" style="color:var(--amber)" target="_blank" rel="noopener">myaccount.google.com/permissions</a>, find <strong>hiagents</strong> in the list, click <strong>Remove access</strong>, then come back and click <strong>Connect Gmail</strong> again.',
          backHref: '/admin',
          backText: '← Back to dashboard',
        });
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

    renderOAuthError(res, {
      status: 400,
      title: 'Unknown sign-in flow',
      message:
        "We don't recognise the kind of sign-in that just came back. Start over from the sign-in page.",
      backHref,
      backText,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, state: stateRaw, ip: req.ip }, 'oauth callback failed');
    renderOAuthError(res, {
      status: 500,
      title: 'Sign-in failed',
      message:
        "We couldn't complete the sign-in. Try again — and if this keeps happening, email <a href=\"mailto:hi@hiagents.digital\" style=\"color:var(--amber)\">hi@hiagents.digital</a> with what you were trying to do.",
      backHref,
      backText,
    });
  }
});
