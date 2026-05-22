import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { findTenantForEmail, touchMembership } from '../tenant/store.js';
import { sendError } from './errors.js';

const COOKIE = 'hiagents_admin';

// Reject cookies older than this even if the signature is valid. Browser
// maxAge is enforced client-side; this is the server-side belt.
const MAX_COOKIE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sign(value: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface Session {
  email: string;
  tenantId: string;
  ts: number;
}

function encode(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url');
}
function decode(b: string): string {
  return Buffer.from(b, 'base64url').toString('utf-8');
}

function parseSession(value: string | undefined): Session | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [ts, emailB64, tenantB64, sig] = parts;
  if (!ts || !emailB64 || !tenantB64 || !sig) return null;
  const payload = `${ts}.${emailB64}.${tenantB64}`;
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const email = decode(emailB64);
    const tenantId = decode(tenantB64);
    if (!email || !tenantId) return null;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return null;
    // Server-side expiry: refuse cookies older than MAX_COOKIE_AGE_MS even
    // if the HMAC is intact (defends against a leaked but unrotated cookie).
    if (Date.now() - tsNum > MAX_COOKIE_AGE_MS) return null;
    return { email, tenantId, ts: tsNum };
  } catch {
    return null;
  }
}

function issueCookie(res: Response, email: string, tenantId: string): void {
  const ts = String(Date.now());
  const emailB64 = encode(email);
  const tenantB64 = encode(tenantId);
  const payload = `${ts}.${emailB64}.${tenantB64}`;
  const sig = sign(payload);
  res.cookie(COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: MAX_COOKIE_AGE_MS,
  });
}

export function issueSessionForEmail(res: Response, email: string, tenantId: string): void {
  issueCookie(res, email.toLowerCase(), tenantId);
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
  });
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = parseSession(req.cookies?.[COOKIE]);
  if (session && session.email && session.tenantId) {
    const found = await findTenantForEmail(session.email);
    if (found && found.tenant.id === session.tenantId && !found.tenant.deletedAt) {
      res.locals.adminEmail = session.email;
      res.locals.tenantId = found.tenant.id;
      res.locals.tenant = found.tenant;
      res.locals.membershipId = found.membership.id;
      touchMembership(found.membership.id).catch(() => {
        /* non-critical */
      });
      next();
      return;
    }
  }
  if (req.path.startsWith('/api/') || req.xhr) {
    sendError(res, 401, {
      code: 'unauthorized',
      message: 'Your session has expired. Sign in again to continue.',
    });
  } else {
    res.redirect('/admin/login');
  }
}

export function getSessionEmail(req: Request): string | null {
  const session = parseSession(req.cookies?.[COOKIE]);
  return session?.email ?? null;
}

// ============================================================
// CSRF: double-submit token bound to the session.
// Token = HMAC(SESSION_SECRET, sessionTs + nonce). Client reads it from
// a non-httpOnly cookie and echoes via header X-CSRF-Token; server verifies.
// ============================================================

const CSRF_COOKIE = 'hiagents_csrf';

export function issueCsrfToken(res: Response): string {
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const sig = sign(`csrf:${nonce}`);
  const token = `${nonce}.${sig}`;
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // browser JS reads this and echoes via header
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: MAX_COOKIE_AGE_MS,
  });
  return token;
}

export function verifyCsrf(req: Request): boolean {
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('X-CSRF-Token') ?? req.get('x-csrf-token');
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') return false;
  if (!safeEqual(cookieToken, headerToken)) return false;
  const parts = cookieToken.split('.');
  if (parts.length !== 2) return false;
  const [nonce, sig] = parts;
  if (!nonce || !sig) return false;
  return safeEqual(sig, sign(`csrf:${nonce}`));
}

/**
 * Express middleware: rejects state-changing requests without a valid CSRF
 * header. Apply only to admin POST/PUT/DELETE — not to OAuth callbacks
 * (browser-driven, no opportunity to read the cookie).
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const m = req.method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    next();
    return;
  }
  if (verifyCsrf(req)) {
    next();
    return;
  }
  sendError(res, 403, {
    code: 'csrf-failed',
    message:
      'Your session expired or this request was blocked for security. Refresh the page and try again.',
  });
}
