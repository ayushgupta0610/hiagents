import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';

const COOKIE = 'inbox_ai_admin';

// Special sentinel for password-based sessions (not a valid email)
const PASSWORD_SESSION = '__password__';

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
  email: string; // real email OR PASSWORD_SESSION
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
  if (parts.length !== 3) return null;
  const [ts, emailB64, sig] = parts;
  if (!ts || !emailB64 || !sig) return null;
  const payload = `${ts}.${emailB64}`;
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    return { email: decode(emailB64), ts: Number(ts) };
  } catch {
    return null;
  }
}

function issueCookie(res: Response, email: string): void {
  const ts = String(Date.now());
  const emailB64 = encode(email);
  const payload = `${ts}.${emailB64}`;
  const sig = sign(payload);
  res.cookie(COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function issueSessionForEmail(res: Response, email: string): void {
  issueCookie(res, email.toLowerCase());
}

export function issueSessionForPassword(res: Response): void {
  issueCookie(res, PASSWORD_SESSION);
}

// Kept for backwards-compat with any callers still using the old name
export function issueSessionCookie(res: Response): void {
  issueSessionForPassword(res);
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' });
}

export function adminEmails(): string[] {
  if (!env.ADMIN_EMAILS) return [];
  return env.ADMIN_EMAILS
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  const list = adminEmails();
  if (list.length === 0) return false;
  return list.includes(email.toLowerCase());
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = parseSession(req.cookies?.[COOKIE]);
  const authorized =
    session !== null &&
    (session.email === PASSWORD_SESSION || isAdminEmail(session.email));
  if (authorized) {
    res.locals.adminEmail = session?.email === PASSWORD_SESSION ? null : session?.email;
    next();
    return;
  }
  // API routes always return 401 JSON so client-side fetch() can detect and
  // redirect to the login page. Page routes redirect to /admin/login directly.
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
  return session.email === PASSWORD_SESSION ? null : session.email;
}
