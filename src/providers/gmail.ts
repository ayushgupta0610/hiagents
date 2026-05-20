import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { db } from '../db/client.js';
import { env } from '../config.js';
import { OUTGOING_LOOP_HEADERS } from '../pipeline/loop-guard.js';
import { logger } from '../lib/logger.js';
import type { IncomingEmail } from '../types.js';
import type { ThreadMessage } from '../pipeline/thread-guard.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function getOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export async function loadStoredTokens(): Promise<OAuth2Client | null> {
  const { data, error } = await db().from('oauth_tokens').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Failed to load oauth tokens: ${error.message}`);
  if (!data) return null;
  const oauth = getOAuthClient();
  oauth.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: new Date(data.expires_at).getTime(),
    scope: data.scope,
  });
  oauth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await db()
        .from('oauth_tokens')
        .update({
          access_token: tokens.access_token,
          expires_at: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : new Date(Date.now() + 3500_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);
      logger.debug('refreshed gmail access token');
    }
  });
  return oauth;
}

export async function saveTokens(
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
        id: 1,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(tokens.expiry_date).toISOString(),
        scope: tokens.scope,
        email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
}

async function gmailClient(): Promise<gmail_v1.Gmail> {
  const auth = await loadStoredTokens();
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

export async function listUnreadInbox(maxResults = 25): Promise<string[]> {
  const gmail = await gmailClient();
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox is:unread -category:promotions -category:social',
    maxResults,
  });
  return (res.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function fetchMessage(messageId: string): Promise<IncomingEmail> {
  const gmail = await gmailClient();
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

export async function fetchThreadMessages(threadId: string): Promise<ThreadMessage[]> {
  const gmail = await gmailClient();
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

export async function markRead(messageId: string): Promise<void> {
  const gmail = await gmailClient();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

export async function applyLabel(messageId: string, labelName: string): Promise<void> {
  const gmail = await gmailClient();
  const labels = await gmail.users.labels.list({ userId: 'me' });
  let labelId = labels.data.labels?.find((l) => l.name === labelName)?.id ?? undefined;
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
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

export interface SendReplyInput {
  threadId: string;
  inReplyToMessageId: string;
  originalMessageIdHeader?: string; // RFC 5322 Message-ID from the original email's headers
  to: string;
  subject: string;
  bodyText: string;
}

export async function sendReply(input: SendReplyInput): Promise<string> {
  const gmail = await gmailClient();
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
