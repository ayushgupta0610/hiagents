import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { findTenantForEmail, touchMembership } from '../tenant/store.js';

const COOKIE = 'inbox_ai_admin';

function sign(value: string): string {
  return createHmac('sha256', env.ADMIN_PASSWORD).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface Session {
  email: string;
  tenantId: string | null;
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
    const decoded = decode(tenantB64);
    return { email, tenantId: decoded === '' ? null : decoded, ts: Number(ts) };
  } catch {
    return null;
  }
}

function issueCookie(res: Response, email: string, tenantId: string | null): void {
  const ts = String(Date.now());
  const emailB64 = encode(email);
  const tenantB64 = encode(tenantId ?? '');
  const payload = `${ts}.${emailB64}.${tenantB64}`;
  const sig = sign(payload);
  res.cookie(COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function issueSessionForEmail(res: Response, email: string, tenantId: string): void {
  issueCookie(res, email.toLowerCase(), tenantId);
}

export function issueSessionForPassword(res: Response): void {
  issueCookie(res, '__password__', null);
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

  if (session && session.email === '__password__') {
    res.locals.adminEmail = null;
    res.locals.tenantId = null;
    res.locals.passwordSession = true;
    next();
    return;
  }

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
    res.status(401).json({ error: 'unauthorized', loginUrl: '/admin/login' });
  } else {
    res.redirect('/admin/login');
  }
}

export function checkPassword(input: string): boolean {
  return safeEqual(input, env.ADMIN_PASSWORD);
}

export function getSessionEmail(req: Request): string | null {
  const session = parseSession(req.cookies?.[COOKIE]);
  if (!session) return null;
  return session.email === '__password__' ? null : session.email;
}

export function adminEmails(): string[] {
  // Backwards-compat shim: in SaaS mode this returns empty (whitelist comes from memberships).
  // Kept so existing callers in oauth.ts compile until they're migrated.
  return [];
}

export function isAdminEmail(_email: string): boolean {
  // In SaaS mode, every Google-signed-in email is allowed (auto-provisioned tenant).
  return true;
}
