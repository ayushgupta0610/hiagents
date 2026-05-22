import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { db } from '../db/client.js';
import { env } from '../config.js';
import { OUTGOING_LOOP_HEADERS } from '../pipeline/loop-guard.js';
import { logger } from '../lib/logger.js';
import { encryptToken, decryptToken } from '../lib/crypto.js';
import type { IncomingEmail } from '../types.js';
import type { ThreadMessage } from '../pipeline/thread-guard.js';

export const MAILBOX_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

export const SIGNIN_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

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
  return client.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
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
  // when the v1: prefix is absent) so existing tenants keep working until
  // their next token rotation re-saves them encrypted.
  oauth.setCredentials({
    access_token: decryptToken(data.access_token),
    refresh_token: decryptToken(data.refresh_token),
    expiry_date: new Date(data.expires_at).getTime(),
    scope: data.scope,
  });
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id' },
    );
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

export async function listUnreadInbox(tenantId: string, maxResults = 25): Promise<string[]> {
  const gmail = await getGmailClientForTenant(tenantId);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox is:unread -category:promotions -category:social',
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

export async function markRead(tenantId: string, messageId: string): Promise<void> {
  const gmail = await getGmailClientForTenant(tenantId);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

// Per-tenant cache of Gmail label name → id. Label ids are stable for the
// life of the mailbox; without this cache, every applyLabel call burns an
// extra users.labels.list quota unit (2× the cost of the modify itself).
// The cache only ever grows by labels we ourselves create, so it's tiny
// (handful of `inbox-ai/*` labels per tenant).
const labelIdCache = new Map<string, Map<string, string>>();

function getLabelCache(tenantId: string): Map<string, string> {
  let m = labelIdCache.get(tenantId);
  if (!m) {
    m = new Map();
    labelIdCache.set(tenantId, m);
  }
  return m;
}

export async function applyLabel(
  tenantId: string,
  messageId: string,
  labelName: string,
): Promise<void> {
  const gmail = await getGmailClientForTenant(tenantId);
  const cache = getLabelCache(tenantId);
  let labelId = cache.get(labelName);
  if (!labelId) {
    const labels = await gmail.users.labels.list({ userId: 'me' });
    labelId = labels.data.labels?.find((l) => l.name === labelName)?.id ?? undefined;
    if (!labelId) {
      const created = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });
      if (!created.data.id) throw new Error(`Failed to create label ${labelName}`);
      labelId = created.data.id;
    }
    cache.set(labelName, labelId);
  }
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

// Clears the in-process label-id cache for a tenant. Called when a user
// reconnects their mailbox (different Gmail account = different label ids).
export function clearLabelCacheForTenant(tenantId: string): void {
  labelIdCache.delete(tenantId);
}

export interface SendReplyInput {
  threadId: string;
  inReplyToMessageId: string;
  originalMessageIdHeader?: string;
  to: string;
  subject: string;
  bodyText: string;
}

export async function sendReply(tenantId: string, input: SendReplyInput): Promise<string> {
  const gmail = await getGmailClientForTenant(tenantId);
  const rawMsgId = input.originalMessageIdHeader?.trim() ?? `<${input.inReplyToMessageId}>`;
  const msgIdRef = rawMsgId.startsWith('<') ? rawMsgId : `<${rawMsgId}>`;
  const headerLines = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `In-Reply-To: ${msgIdRef}`,
    `References: ${msgIdRef}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    ...Object.entries(OUTGOING_LOOP_HEADERS).map(([k, v]) => `${k}: ${v}`),
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
