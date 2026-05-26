// OAuth state-nonce machinery — split out of routes/oauth.ts so the route
// handlers there read top-to-bottom as "what each endpoint does", not as
// "what each endpoint does plus 80 lines of cookie crypto".
//
// The nonce defends /oauth/callback against forged-callback phishing.
// Every flow that starts via /oauth/signin or /oauth/start mints a 16-byte
// random nonce, signs `oauth:<payload>` with SESSION_SECRET, and stores
// the result in a 10-minute httpOnly cookie scoped to /oauth. /oauth/callback
// consumes the cookie (single-use, always cleared) and rejects any state
// mismatch.
//
// Cookie attributes:
//   httpOnly: JS can't read it (defense against XSS exfiltrating the nonce)
//   sameSite=lax: travels on the top-level redirect from Google
//   secure (prod only): never over plain HTTP
//   path=/oauth: never sent to other routes, never gets cleared by them
//   maxAge=10min: long enough for the user to complete consent, short
//                 enough to limit the attack window

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../config.js';

export const STATE_COOKIE = 'hiagents_oauth_state';
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

/** Generate a fresh random nonce suitable for an OAuth state payload. */
export function generateNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Set the signed state cookie. Pair every call with a redirect to Google. */
export function setStateCookie(res: Response, statePayload: string): void {
  const cookieValue = `${statePayload}.${signState(statePayload)}`;
  res.cookie(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: STATE_MAX_AGE_MS,
    path: '/oauth',
  });
}

/**
 * Read and clear the state cookie, returning the unsigned payload if and
 * only if the HMAC verifies. Always clears the cookie — single-use, even
 * on failure (otherwise a leaked cookie could be replayed).
 */
export function consumeStateCookie(req: Request, res: Response): string | null {
  const raw = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/oauth' });
  if (typeof raw !== 'string') return null;
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const payload = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);
  if (!safeEqual(sig, signState(payload))) return null;
  return payload;
}

/**
 * Compare two states in constant time. Used to verify the URL `state`
 * query param matches the cookie's payload before exchanging the code.
 */
export function stateEquals(a: string, b: string): boolean {
  return safeEqual(a, b);
}
