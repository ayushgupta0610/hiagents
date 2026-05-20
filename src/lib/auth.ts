import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';

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

export function issueSessionCookie(res: Response): void {
  const ts = String(Date.now());
  const value = `${ts}.${sign(ts)}`;
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function isValidCookie(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const ts = parts[0];
  const sig = parts[1];
  if (!ts || !sig) return false;
  return safeEqual(sig, sign(ts));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isValidCookie(req.cookies?.[COOKIE])) {
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
