import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { env } from '../config.js';
import type { IncomingEmail, Classification, ReplyStatus } from '../types.js';
import { isAutoOrBulk } from './loop-guard.js';
import { loadBotSentIdsForThread, ownerHasReplied } from './thread-guard.js';
import { classify } from './classifier.js';
import { search } from '../kb/search.js';
import { generateReply } from './generate.js';
import { fetchThreadMessages, sendReply } from '../providers/gmail.js';

export interface RunResult {
  classification: Classification;
  replyStatus: ReplyStatus | 'none';
  replyReason?: string;
}

function isFromSelf(email: IncomingEmail): boolean {
  const match = email.from.match(/<([^>]+)>/);
  const sender = (match?.[1] ?? email.from).trim().toLowerCase();
  return sender === env.GMAIL_ADDRESS.toLowerCase();
}

export async function runPipeline(email: IncomingEmail): Promise<RunResult> {
  const supabase = db();

  // Idempotency: skip if we've already processed this message id
  const { data: existing } = await supabase
    .from('messages')
    .select('id')
    .eq('gmail_message_id', email.gmailMessageId)
    .maybeSingle();
  if (existing) {
    logger.info({ id: email.gmailMessageId }, 'already processed, skipping');
    return { classification: 'other', replyStatus: 'none', replyReason: 'already-processed' };
  }

  const baseRow = {
    gmail_message_id: email.gmailMessageId,
    gmail_thread_id: email.gmailThreadId,
    received_at: email.receivedAt.toISOString(),
    from_address: email.from,
    subject: email.subject,
    body_text: email.bodyText.slice(0, 50000),
  };

  // Guard: self-sent
  if (isFromSelf(email)) {
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'skipped_self',
      reply_status: 'skipped',
      reply_reason: 'from-self',
    });
    return { classification: 'skipped_self', replyStatus: 'skipped' };
  }

  // Guard: auto/bulk
  if (isAutoOrBulk(email.headers)) {
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'skipped_loop',
      reply_status: 'skipped',
      reply_reason: 'auto-or-bulk-headers',
    });
    return { classification: 'skipped_loop', replyStatus: 'skipped' };
  }

  // Guard: owner already replied in this thread
  const botSentIds = await loadBotSentIdsForThread(email.gmailThreadId);
  const threadMessages = await fetchThreadMessages(email.gmailThreadId);
  if (ownerHasReplied(threadMessages, env.GMAIL_ADDRESS, botSentIds)) {
    await supabase.from('messages').insert({
      ...baseRow,
      classification: 'skipped_thread',
      reply_status: 'skipped',
      reply_reason: 'owner-replied-manually',
    });
    return { classification: 'skipped_thread', replyStatus: 'skipped' };
  }

  try {
    // Classify
    const verdict = await classify({
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

    // Retrieve
    const query = `${email.subject}\n\n${email.bodyText}`;
    const chunks = await search(query);
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

    // Generate
    const replyText = await generateReply({ email, chunks });

    // Send via Gmail
    const sentId = await sendReply({
      threadId: email.gmailThreadId,
      inReplyToMessageId: email.gmailMessageId,
      originalMessageIdHeader: email.headers['message-id'],
      to: email.from,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      bodyText: replyText,
    });

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

    logger.info({ id: email.gmailMessageId, topSim, chunks: chunks.length }, 'reply sent');
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
