import type { Response } from 'express';
import { logger } from './logger.js';

// Consistent error envelope for every JSON API response on failure.
//
//   { error: "machine-readable-code", message: "user-friendly sentence" }
//
// Routes call sendError(res, status, code, message, optional metadata).
// UI safeFetch helpers in admin.html / onboarding.html read the `message`
// field and show it to the user verbatim — so messages must be written for
// end-users, not developers (no stack traces, no internal IDs, no jargon).

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'csrf-failed'
  | 'not-found'
  | 'rate-limited'
  | 'validation-failed'
  | 'tenant-required'
  | 'conflict'
  | 'payload-too-large'
  | 'upstream-failed'
  | 'internal-error';

interface SendErrorOptions {
  code: ErrorCode;
  message: string;
  /** Optional details — e.g. zod issues. Logged server-side, NOT echoed to client. */
  internal?: unknown;
  /** Optional structured details safe to send to the client (e.g. field names that failed validation). */
  details?: Record<string, unknown>;
}

export function sendError(res: Response, status: number, opts: SendErrorOptions): void {
  const { code, message, internal, details } = opts;
  if (internal !== undefined) {
    logger.warn(
      {
        status,
        code,
        message,
        internal: internal instanceof Error ? internal.message : internal,
      },
      'request failed',
    );
  }
  const body: { error: ErrorCode; message: string; details?: Record<string, unknown> } = {
    error: code,
    message,
  };
  if (details) body.details = details;
  res.status(status).json(body);
}

// Map a thrown Error from a route handler to a friendly envelope. Used in
// the global error handler in server.ts as a last-resort catch-all so any
// unexpected throw still produces a typed envelope instead of leaking stack
// traces or default Express HTML pages.
export function sendUnhandled(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, 'unhandled error');
  if (res.headersSent) return;
  sendError(res, 500, {
    code: 'internal-error',
    message: 'Something went wrong on our end. Please try again in a moment.',
  });
}
