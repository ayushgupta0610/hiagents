export interface ThreadMessage {
  from: string;
  gmailMessageId: string;
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  const value = match?.[1] ?? from;
  return value.trim().toLowerCase();
}

export function ownerHasReplied(
  thread: ThreadMessage[],
  ownerEmail: string,
  botSentMessageIds: Set<string>,
): boolean {
  const owner = ownerEmail.toLowerCase();
  for (const msg of thread) {
    if (extractEmail(msg.from) === owner && !botSentMessageIds.has(msg.gmailMessageId)) {
      return true;
    }
  }
  return false;
}

export async function loadBotSentIdsForThread(gmailThreadId: string): Promise<Set<string>> {
  const { db } = await import('../db/client.js');
  const { data, error } = await db()
    .from('messages')
    .select('reply_gmail_message_id')
    .eq('gmail_thread_id', gmailThreadId)
    .not('reply_gmail_message_id', 'is', null);
  if (error) throw new Error(`Failed to load bot-sent ids: ${error.message}`);
  return new Set(
    (data ?? []).map((r: { reply_gmail_message_id: string }) => r.reply_gmail_message_id),
  );
}
