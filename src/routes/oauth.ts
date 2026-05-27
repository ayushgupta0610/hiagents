// /oauth/* route handlers.
//
// Three endpoints:
//   GET /oauth/signin      → start the admin sign-in flow (state=login:<nonce>)
//   GET /oauth/start       → start the mailbox-connect flow (state=mailbox:<tenant>:<nonce>)
//   GET /oauth/callback    → unified callback for both flows
//
// State-nonce machinery + the friendly-error rendering are extracted to
// sibling files so this one stays a thin orchestrator:
//
//   ./oauth-state.ts   — setStateCookie / consumeStateCookie / generateNonce / stateEquals
//   ./oauth-errors.ts  — renderOAuthError / explainGoogleError

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
import { auditFireAndForget } from '../tenant/audit.js';
import { logger } from '../lib/logger.js';
import { db } from '../db/client.js';
import {
  generateNonce,
  setStateCookie,
  consumeStateCookie,
  stateEquals,
} from './oauth-state.js';
import { renderOAuthError, explainGoogleError } from './oauth-errors.js';
import { env } from '../config.js';

export const oauthRouter: Router = Router();

// ============================================================
// /oauth/start — mailbox connect (admin already signed in)
// ============================================================
oauthRouter.get('/start', requireAdmin, (_req, res) => {
  const tenantId = res.locals.tenantId;
  if (!tenantId) {
    renderOAuthError(res, {
      title: 'No workspace yet',
      message:
        "You need to be signed in to a workspace before connecting a mailbox. Head back to sign in and we'll provision one for you.",
    });
    return;
  }
  const statePayload = `mailbox:${tenantId}:${generateNonce()}`;
  setStateCookie(res, statePayload);
  res.redirect(buildMailboxAuthUrl(statePayload));
});

// ============================================================
// /oauth/signin — admin sign-in (public, auto-provisions tenant)
// ============================================================
//
// Anti-abuse: 5 signin starts per IP per hour. Stops bots from creating
// throwaway tenants en masse, which would each burn the shared OpenRouter
// key on classifier + risk calls before being caught by the per-tenant
// spend cap.
const signinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message:
    'Too many sign-in attempts from this IP. Try again in an hour or contact support if this is a mistake.',
});

oauthRouter.get('/signin', signinLimiter, (_req, res) => {
  const statePayload = `login:${generateNonce()}`;
  setStateCookie(res, statePayload);
  res.redirect(buildSigninAuthUrl(statePayload));
});

// ============================================================
// /oauth/callback — unified callback for both flows
// ============================================================
//
// Walks four checks in order, each with its own friendly error page:
//   0. Google sent an explicit ?error= → render explained card
//   1. State nonce matches the signed cookie we set when the flow began
//   2. We received an authorization code
//   3. Exchanging the code returns an access token + email
//
// Then dispatches on stateKind ("login" or "mailbox").

oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const stateRaw = typeof req.query.state === 'string' ? req.query.state : '';
  const errorCode = typeof req.query.error === 'string' ? req.query.error : null;
  const errorDescription =
    typeof req.query.error_description === 'string' ? req.query.error_description : '';

  // Pre-compute the back-button target based on the state kind — best-effort
  // even if the state cookie is gone or malformed, because the URL `state`
  // param still tells us whether this was a signin or mailbox-connect flow.
  const isMailboxFlow = stateRaw.startsWith('mailbox:');
  const backHref = isMailboxFlow ? '/admin' : '/admin/login';
  const backText = isMailboxFlow ? '← Back to dashboard' : '← Back to sign in';

  // 0. Google sent an explicit error (denied / blocked / chooser closed).
  if (errorCode) {
    logger.warn(
      { ip: req.ip, errorCode, errorDescription, stateRaw },
      'oauth callback received explicit Google error',
    );
    consumeStateCookie(req, res); // single-use, always clear
    renderOAuthError(res, {
      ...explainGoogleError(errorCode, errorDescription),
      backHref,
      backText,
    });
    return;
  }

  // 1. Verify state nonce matches the signed cookie we set at flow start.
  const cookiePayload = consumeStateCookie(req, res);
  if (!cookiePayload || !stateRaw || !stateEquals(stateRaw, cookiePayload)) {
    logger.warn(
      { ip: req.ip, stateRaw, hadCookie: !!cookiePayload },
      'oauth callback rejected: state nonce mismatch',
    );
    renderOAuthError(res, {
      title: 'Sign-in link expired',
      message:
        "This sign-in link is invalid or has expired (the page may have sat open for more than 10 minutes). Start over from the sign-in page.",
      backHref,
      backText,
    });
    return;
  }

  // 2. We need a code from here on.
  const [stateKind, stateTenantOrNonce] = stateRaw.split(':');
  if (!code) {
    renderOAuthError(res, {
      title: 'Sign-in incomplete',
      message:
        "Google didn't send us an authorization code. This usually means the consent screen was closed before you finished — try again.",
      backHref,
      backText,
    });
    return;
  }

  try {
    // 3. Exchange code for tokens + fetch the user's email from Google.
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      renderOAuthError(res, {
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
        title: 'Sign-in failed',
        message:
          "Google didn't return an email address for your account. Make sure you grant the email-address scope when prompted, then try again.",
        backHref,
        backText,
      });
      return;
    }

    // Dispatch on the flow kind. Each branch is self-contained.
    // Both branches receive `tokens` because the sign-in flow now also
    // saves Gmail mailbox tokens (requested in SIGNIN_SCOPES) — that's
    // what folds onboarding from 4 steps to 3 and merges the two
    // "Account" / "Gmail mailbox" cards in Settings into one.
    if (stateKind === 'login') {
      await handleSigninFlow(req, res, email, tokens);
      return;
    }
    if (stateKind === 'mailbox') {
      await handleMailboxFlow(req, res, email, tokens, stateTenantOrNonce);
      return;
    }

    renderOAuthError(res, {
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
      message: env.SUPPORT_EMAIL
        ? `We couldn\'t complete the sign-in. Try again — and if this keeps happening, email <a href="mailto:${env.SUPPORT_EMAIL}" style="color:var(--amber)">${env.SUPPORT_EMAIL}</a> with what you were trying to do.`
        : "We couldn't complete the sign-in. Try again.",
      backHref,
      backText,
    });
  }
});

// ------------------------------------------------------------
// Flow handlers — kept small so the callback orchestrator above
// reads top-to-bottom as a checklist.
// ------------------------------------------------------------

async function handleSigninFlow(
  req: import('express').Request,
  res: import('express').Response,
  email: string,
  tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
    scope?: string | null;
  },
): Promise<void> {
  const found = await findTenantForEmail(email);
  const tenantId = found ? found.tenant.id : (await provisionTenant(email)).id;
  const isNewTenant = !found;

  if (isNewTenant) {
    auditFireAndForget(tenantId, email, 'tenant.provisioned', { via: 'google-signin' });
    logger.info({ email, tenantId }, 'auto-provisioned new tenant');
  }

  // Save mailbox tokens — the whole point of folding the two OAuth flows
  // into one. Three cases:
  //   1. New tenant → always save (no existing mailbox).
  //   2. Existing tenant, no mailbox connected yet → save.
  //   3. Existing tenant, mailbox is already connected as the SAME email →
  //      save (refresh of tokens for the same account).
  //   4. Existing tenant, mailbox is connected as a DIFFERENT email →
  //      do NOT overwrite. The user explicitly set up a split (admin
  //      signs in as A, bot manages B). Silently overwriting B's
  //      tokens would break their bot. Log + skip; they can use
  //      "Use a different Google account" in Settings to switch
  //      explicitly if they want.
  //
  // Token persistence requires a refresh_token. Sign-in with
  // prompt='select_account consent' always returns one; if it ever
  // doesn't we just skip the save (the user can re-OAuth from Settings).
  if (tokens.access_token && tokens.refresh_token) {
    const existing = await db()
      .from('oauth_tokens')
      .select('email')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const existingEmail = (existing.data as { email: string } | null)?.email ?? null;
    const safeToOverwrite = !existingEmail || existingEmail.toLowerCase() === email;
    if (safeToOverwrite) {
      await saveTokensForTenant(
        tenantId,
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date ?? Date.now() + 3500_000,
          scope: tokens.scope ?? MAILBOX_SCOPES.join(' '),
        },
        email,
      );
      if (isNewTenant || !existingEmail) {
        auditFireAndForget(tenantId, email, 'gmail.connected', { via: 'signin', ip: req.ip });
        logger.info({ email, tenantId }, 'gmail mailbox connected during signin');
      }
    } else {
      logger.info(
        { signinEmail: email, mailboxEmail: existingEmail, tenantId },
        'signin email differs from connected mailbox — keeping existing mailbox tokens',
      );
    }
  }

  issueSessionForEmail(res, email, tenantId);
  auditFireAndForget(tenantId, email, 'auth.signin', { method: 'google', ip: req.ip });

  // Where to land: brand-new tenant → onboarding. Existing tenant →
  // wherever they were last (onboarding if incomplete, dashboard if done).
  if (isNewTenant) {
    res.redirect('/admin/onboarding');
    return;
  }
  res.redirect(found!.tenant.onboardingCompletedAt ? '/admin' : '/admin/onboarding');
}

async function handleMailboxFlow(
  req: import('express').Request,
  res: import('express').Response,
  email: string,
  tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null; scope?: string | null },
  stateTenantId: string | undefined,
): Promise<void> {
  if (!stateTenantId) {
    renderOAuthError(res, {
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
      access_token: tokens.access_token!,
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
}
