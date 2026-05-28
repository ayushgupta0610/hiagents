import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { db } from '../db/client.js';
import { env } from '../config.js';
import { OUTGOING_LOOP_HEADERS } from '../pipeline/loop-guard.js';
import { logger } from '../lib/logger.js';
import { encryptToken, decryptToken } from '../lib/crypto.js';
import type { IncomingEmail } from '../types.js';
import type { ThreadMessage } from '../pipeline/thread-guard.js';

// Scopes the bot needs to actually do its job on a Gmail mailbox.
export const MAILBOX_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

// Identity-only scopes — used to be the sign-in flow on its own. Now folded
// into SIGNIN_SCOPES below so sign-in and mailbox-connect are one OAuth.
// Kept exported in case a future "pure identity" flow needs them.
export const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// First-touch sign-in scopes. We deliberately request the full mailbox
// scope set at sign-in, not just identity — so the very first OAuth dance
// connects the user's Gmail too, dropping onboarding from 4 steps to 3
// and collapsing the duplicate "Account" + "Gmail mailbox" cards in
// Settings to one. The rare case of "I want to sign in as A but have the
// bot manage B" is still supported via /oauth/start ("Use a different
// Google account") in Settings.
export const SIGNIN_SCOPES = Array.from(new Set([...IDENTITY_SCOPES, ...MAILBOX_SCOPES]));

export const SCOPES = MAILBOX_SCOPES;

export function getOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

// `state` is built and signed by the caller (routes/oauth.ts) so the state
// nonce defends against forged callbacks. Callers MUST pass the same state
// payload they stored in the oauth_state cookie.
export function buildMailboxAuthUrl(state: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    // 'select_account consent' forces both the account picker (so users can
    // pick a different Gmail when reconnecting) AND the consent screen (so
    // Google reliably returns a refresh_token).
    prompt: 'select_account consent',
    scope: MAILBOX_SCOPES,
    state,
  });
}

export function buildSigninAuthUrl(state: string): string {
  const client = getOAuthClient();
  // access_type=offline + prompt 'consent' is what makes Google reliably
  // return a refresh_token. We need it because /oauth/signin now also
  // grants the mailbox scopes — so the very first sign-in connects the
  // Gmail mailbox (no separate /oauth/start step on the happy path).
  // The 'select_account' part keeps the account picker visible so users
  // with multiple Google accounts can pick the right one.
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: SIGNIN_SCOPES,
    state,
  });
}

export async function loadStoredTokensForTenant(tenantId: string): Promise<OAuth2Client | null> {
  const { data, error } = await db()
    .from('oauth_tokens')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load oauth tokens: ${error.message}`);
  if (!data) return null;
  const oauth = getOAuthClient();
  // Tokens are encrypted at rest with AES-256-GCM. decryptToken is backward
  // compatible with rows written before encryption shipped (returns as-is
  // when the v1: prefix is absent).
  const accessPlain = decryptToken(data.access_token);
  const refreshPlain = decryptToken(data.refresh_token);
  oauth.setCredentials({
    access_token: accessPlain,
    refresh_token: refreshPlain,
    expiry_date: new Date(data.expires_at).getTime(),
    scope: data.scope,
  });

  // Opportunistic re-encryption of legacy plaintext rows. Without this, any
  // refresh_token written before AES-256-GCM landed stays plaintext forever
  // (Google rarely issues a fresh refresh_token, so the existing OAuth2Client
  // 'tokens' handler below almost never re-saves it). Detect the missing
  // v1: prefix on read and immediately write the encrypted form back. Fire-
  // and-forget — failure is logged but the request continues.
  const accessIsLegacy = !data.access_token.startsWith('v1:');
  const refreshIsLegacy = !data.refresh_token.startsWith('v1:');
  if (accessIsLegacy || refreshIsLegacy) {
    const patch: Record<string, unknown> = {};
    if (accessIsLegacy) patch.access_token = encryptToken(accessPlain);
    if (refreshIsLegacy) patch.refresh_token = encryptToken(refreshPlain);
    db()
      .from('oauth_tokens')
      .update(patch)
      .eq('tenant_id', tenantId)
      .then(({ error: upErr }) => {
        if (upErr) {
          logger.warn(
            { tenantId, err: upErr.message, fields: Object.keys(patch) },
            'opportunistic token re-encrypt failed',
          );
        } else {
          logger.info(
            { tenantId, fields: Object.keys(patch) },
            'opportunistically re-encrypted legacy oauth token row',
          );
        }
      });
  }
  oauth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      const patch: Record<string, unknown> = {
        access_token: encryptToken(tokens.access_token),
        expires_at: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : new Date(Date.now() + 3500_000).toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (tokens.refresh_token) patch.refresh_token = encryptToken(tokens.refresh_token);
      try {
        await db().from('oauth_tokens').update(patch).eq('tenant_id', tenantId);
        logger.debug({ tenantId }, 'refreshed gmail access token');
      } catch (err) {
        logger.error(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          'failed to persist refreshed token',
        );
      }
    }
  });
  return oauth;
}

export async function saveTokensForTenant(
  tenantId: string,
  tokens: {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
    scope: string;
  },
  email: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db()
    .from('oauth_tokens')
    .upsert(
      {
        tenant_id: tenantId,
        access_token: encryptToken(tokens.access_token),
        refresh_token: encryptToken(tokens.refresh_token),
        expires_at: new Date(tokens.expiry_date).toISOString(),
        scope: tokens.scope,
        email,
        updated_at: now,
        connected_at: now,
      },
      { onConflict: 'tenant_id' },
    );
}

export async function bumpConnectedAt(tenantId: string): Promise<void> {
  await db()
    .from('oauth_tokens')
    .update({ connected_at: new Date().toISOString() })
    .eq('tenant_id', tenantId);
}

async function getGmailClientForTenant(tenantId: string): Promise<gmail_v1.Gmail> {
  const auth = await loadStoredTokensForTenant(tenantId);
  if (!auth) throw new Error('Gmail not connected. Visit /oauth/start to authorize.');
  return google.gmail({ version: 'v1', auth });
}

function header(parts: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return parts?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (!part) continue;
      const text = decodeBody(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function headersToMap(
  parts: gmail_v1.Schema$MessagePartHeader[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of parts ?? []) {
    if (h.name && typeof h.value === 'string') map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

export async function listUnreadInbox(
  tenantId: string,
  connectedAt: Date,
  maxResults = 25,
): Promise<string[]> {
  const gmail = await getGmailClientForTenant(tenantId);
  const afterSeconds = Math.floor(connectedAt.getTime() / 1000);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `in:inbox is:unread -category:promotions -category:social after:${afterSeconds}`,
    maxResults,
  });
  return (res.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function fetchMessage(tenantId: string, messageId: string): Promise<IncomingEmail> {
  const gmail = await getGmailClientForTenant(tenantId);
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const m = res.data;
  if (!m.id || !m.threadId) {
    throw new Error(`Gmail message ${messageId} missing id or threadId`);
  }
  const headers = headersToMap(m.payload?.headers);
  const from = header(m.payload?.headers, 'From');
  const subject = header(m.payload?.headers, 'Subject');
  const to = header(m.payload?.headers, 'To')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const internalDate = m.internalDate ? new Date(Number(m.internalDate)) : new Date();
  const bodyText = decodeBody(m.payload ?? undefined).slice(0, 200_000);
  return {
    gmailMessageId: m.id,
    gmailThreadId: m.threadId,
    receivedAt: internalDate,
    from,
    to,
    subject,
    bodyText,
    headers,
  };
}

export async function fetchThreadMessages(
  tenantId: string,
  threadId: string,
): Promise<ThreadMessage[]> {
  const gmail = await getGmailClientForTenant(tenantId);
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From'],
  });
  return (res.data.messages ?? [])
    .filter((m): m is gmail_v1.Schema$Message & { id: string } => typeof m.id === 'string')
    .map((m) => ({
      gmailMessageId: m.id,
      from: header(m.payload?.headers, 'From'),
    }));
}

export interface SendReplyInput {
  threadId: string;
  inReplyToMessageId: string;
  originalMessageIdHeader?: string;
  to: string;
  subject: string;
  bodyText: string;
}

// Strip CR/LF (and other RFC 2822-illegal whitespace) from any value that
// will be interpolated into an outbound mail header. Without this, an inbound
// email with `From: foo\r\nBcc: attacker@evil.com` would inject a Bcc into
// every auto-reply. Encodes anything still suspicious so we don't ship a
// raw \0 either.
export function sanitizeHeader(value: string, maxLen = 1000): string {
  return value
    .replace(/[\r\n\0]/g, ' ') // CRLF/LF/CR/NUL — the actual injection vectors
    .replace(/\s+/g, ' ') // collapse runs of whitespace produced above
    .trim()
    .slice(0, maxLen);
}

// Message-IDs must look like <something@host>. Reject anything that doesn't
// match before echoing it into In-Reply-To / References, since those go into
// outbound headers too. If the inbound id is malformed or absent, fall back
// to the Gmail-assigned message id.
export function sanitizeMessageId(raw: string | undefined, fallbackId: string): string {
  const cleaned = (raw ?? '').replace(/[\r\n\0]/g, '').trim();
  // Conservative RFC 5322 msg-id shape: <local-part@domain>. We only need
  // *enough* validation to refuse line breaks and stray header injection.
  if (/^<[^<>\s]+@[^<>\s]+>$/.test(cleaned)) return cleaned;
  return `<${fallbackId}>`;
}

export async function sendReply(tenantId: string, input: SendReplyInput): Promise<string> {
  const gmail = await getGmailClientForTenant(tenantId);
  const safeTo = sanitizeHeader(input.to, 320); // RFC 5321 max email length
  const safeSubject = sanitizeHeader(input.subject, 998); // RFC 5322 line length
  const msgIdRef = sanitizeMessageId(input.originalMessageIdHeader, input.inReplyToMessageId);
  const headerLines = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    `In-Reply-To: ${msgIdRef}`,
    `References: ${msgIdRef}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    ...Object.entries(OUTGOING_LOOP_HEADERS).map(([k, v]) => `${k}: ${sanitizeHeader(v)}`),
  ];
  const raw = `${headerLines.join('\r\n')}\r\n\r\n${input.bodyText}`;
  const encoded = Buffer.from(raw, 'utf-8').toString('base64url');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded, threadId: input.threadId },
  });
  if (!res.data.id) throw new Error('Gmail send response missing message id');
  return res.data.id;
}
