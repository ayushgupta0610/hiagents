import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { assertEmailQuota, LimitExceededError } from '../tenant/limits.js';
import type { Tenant } from '../tenant/store.js';
import type { IncomingEmail, Classification, ReplyStatus } from '../types.js';
import { isAutoOrBulk } from './loop-guard.js';
import { loadBotSentIdsForThread, ownerHasReplied } from './thread-guard.js';
import { classify } from './classifier.js';
import { search } from '../kb/search.js';
import { generateReply } from './generate.js';
import { fetchThreadMessages, sendReply, type SendReplyInput } from '../providers/gmail.js';

export interface RunResult {
  classification: Classification;
  replyStatus: ReplyStatus | 'none';
  replyReason?: string;
}

export interface RunContext {
  tenant: Tenant;
  ownerEmail: string;
}

function isFromSelf(email: IncomingEmail, ownerEmail: string): boolean {
  const match = email.from.match(/<([^>]+)>/);
  const sender = (match?.[1] ?? email.from).trim().toLowerCase();
  return sender === ownerEmail.toLowerCase();
}

export async function runPipeline(ctx: RunContext, email: IncomingEmail): Promise<RunResult> {
  const supabase = db();
  const settings = ctx.tenant.settings;
  const tenantId = ctx.tenant.id;

  const { data: existing } = await supabase
    .from('messages')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('gmail_message_id', email.gmailMessageId)
    .maybeSingle();
  if (existing) {
    logger.info({ tenantId, id: email.gmailMessageId }, 'already processed');
    return { classification: 'other', replyStatus: 'none', replyReason: 'already-processed' };
  }

  const baseRow = {
    tenant_id: tenantId,
    gmail_message_id: email.gmailMessageId,
    gmail_thread_id: email.gmailThreadId,
    received_at: email.receivedAt.toISOString(),
    from_address: email.from,
    subject: email.subject,
    body_text: email.bodyText.slice(0, 50_000),
  };

  try {
    await assertEmailQuota(tenantId, settings);
  } catch (err) {
    if (err instanceof LimitExceededError) {
      logger.warn({ tenantId, code: err.code }, 'daily email cap reached');
      await supabase.from('messages').insert({
        ...baseRow,
        classification: 'skipped_loop',
        reply_status: 'skipped',
        reply_reason: `daily-cap: ${err.message}`,
      });
      return { classification: 'skipped_loop', replyStatus: 'skipped', replyReason: 'daily-cap' };
    }
    throw err;
  }

  if (isFromSelf(email, ctx.ownerEmail)) {
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'skipped_self',
      reply_status: 'skipped',
      reply_reason: 'from-self',
    });
    return { classification: 'skipped_self', replyStatus: 'skipped' };
  }

  if (isAutoOrBulk(email.headers)) {
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'skipped_loop',
      reply_status: 'skipped',
      reply_reason: 'auto-or-bulk-headers',
    });
    return { classification: 'skipped_loop', replyStatus: 'skipped' };
  }

  const botSentIds = await loadBotSentIdsForThread(tenantId, email.gmailThreadId);
  const threadMessages = await fetchThreadMessages(tenantId, email.gmailThreadId);
  if (ownerHasReplied(threadMessages, ctx.ownerEmail, botSentIds)) {
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'skipped_thread',
      reply_status: 'skipped',
      reply_reason: 'owner-replied-manually',
    });
    return { classification: 'skipped_thread', replyStatus: 'skipped' };
  }

  try {
    const verdict = await classify(tenantId, settings, {
      from: email.from,
      subject: email.subject,
      bodyText: email.bodyText,
    });
    if (verdict === 'other') {
      await supabase.from('messages').insert({
        ...baseRow,
        classification: 'other',
        reply_status: 'skipped',
        reply_reason: 'classifier-other',
      });
      return { classification: 'other', replyStatus: 'skipped' };
    }

    const query = `${email.subject}\n\n${email.bodyText}`;
    const chunks = await search(tenantId, settings, query);
    const topSim = chunks[0]?.similarity ?? 0;

    if (chunks.length === 0) {
      await supabase.from('messages').insert({
        ...baseRow,
        classification: 'client_query',
        top_similarity: 0,
        reply_status: 'skipped',
        reply_reason: 'no-kb-match',
      });
      return { classification: 'client_query', replyStatus: 'skipped', replyReason: 'no-kb-match' };
    }

    const replyText = await generateReply({ tenantId, settings, email, chunks });

    if (!settings.polling.autoSend) {
      await supabase.from('messages').insert({
        ...baseRow,
        classification: 'client_query',
        retrieved_chunk_ids: chunks.map((c) => c.id),
        top_similarity: topSim,
        reply_text: replyText,
        reply_status: 'drafted',
        reply_reason: 'auto-send disabled',
      });
      logger.info({ tenantId, id: email.gmailMessageId }, 'reply drafted (autoSend off)');
      return { classification: 'client_query', replyStatus: 'sent', replyReason: 'drafted' };
    }

    const sendInput: SendReplyInput = {
      threadId: email.gmailThreadId,
      inReplyToMessageId: email.gmailMessageId,
      originalMessageIdHeader: email.headers['message-id'],
      to: email.from,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      bodyText: replyText,
    };
    const sentId = await sendReply(tenantId, sendInput);

    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'client_query',
      retrieved_chunk_ids: chunks.map((c) => c.id),
      top_similarity: topSim,
      reply_text: replyText,
      reply_status: 'sent',
      reply_sent_at: new Date().toISOString(),
      reply_gmail_message_id: sentId,
    });

    logger.info({ tenantId, id: email.gmailMessageId, topSim }, 'reply sent');
    return { classification: 'client_query', replyStatus: 'sent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'error',
      reply_status: 'failed',
      reply_reason: msg.slice(0, 500),
    });
    throw err;
  }
}
