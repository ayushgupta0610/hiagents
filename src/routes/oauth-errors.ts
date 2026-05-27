// Styled error page for /oauth/* failures. Split out of routes/oauth.ts
// so the route file stays focused on flow logic and this file owns the
// presentation + the Google-error vocabulary.
//
// Every OAuth failure path renders through renderOAuthError() — never a
// bare `<p>...</p>`. The page mirrors the dark + amber + Inter aesthetic
// of /admin/login so the user lands somewhere that looks intentional and
// tells them what to do next.

import type { Response } from 'express';
import { env } from '../config.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OAuthErrorOpts {
  status?: number;
  title: string;
  /** Body paragraph. HTML allowed — escape user input at the call site. */
  message: string;
  /** Optional second paragraph in an amber-bordered hint block. */
  hint?: string;
  /** Where the back button points. Defaults to /admin/login. */
  backHref?: string;
  backText?: string;
}

export function renderOAuthError(res: Response, opts: OAuthErrorOpts): void {
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

/**
 * Map Google's standard OAuth `error` query-param codes to an actionable
 * title + body. Unknown codes fall back to a generic page that still
 * echoes the raw code so it shows up in screenshots and the operator can
 * grep logs.
 */
export function explainGoogleError(
  code: string,
  description: string,
): { title: string; message: string; hint?: string } {
  switch (code) {
    case 'access_denied':
      return {
        title: "Google didn't let us in",
        message:
          "Either you cancelled the sign-in, or Google blocked your email from accessing this app.",
        hint: env.SUPPORT_EMAIL
          ? `If you saw an <strong>“Access blocked”</strong> screen, this app is currently in private testing and your Google account isn\'t on the test-users list yet. Reply to your invite email or contact <a href="mailto:${env.SUPPORT_EMAIL}" style="color:var(--amber)">${env.SUPPORT_EMAIL}</a> with the address you tried, and we\'ll add you within a day.`
          : 'If you saw an <strong>“Access blocked”</strong> screen, this app is currently in private testing and your Google account isn\'t on the test-users list yet. Reach out to whoever invited you with the address you tried.',
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
          'The Google sign-in screen closed before you finished granting access. Click the button below to try again.',
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
