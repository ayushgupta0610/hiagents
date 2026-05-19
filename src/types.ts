export type Classification =
  | 'client_query'
  | 'other'
  | 'skipped_loop'
  | 'skipped_thread'
  | 'skipped_self'
  | 'error';

export type ReplyStatus = 'sent' | 'drafted' | 'skipped' | 'failed';

export interface IncomingEmail {
  gmailMessageId: string;
  gmailThreadId: string;
  receivedAt: Date;
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
  headers: Record<string, string>;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  content: string;
  similarity: number;
}
