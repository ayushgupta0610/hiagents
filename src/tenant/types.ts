// src/tenant/types.ts

// Curated list of allowed reply models (prevents tenants from picking expensive Opus etc.)
export const ALLOWED_REPLY_MODELS = [
  'deepseek/deepseek-v4-flash',
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-4o-mini',
] as const;

export const ALLOWED_CLASSIFIER_MODELS = [
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4.5',
  'deepseek/deepseek-v4-flash',
] as const;

export type ReplyModel = typeof ALLOWED_REPLY_MODELS[number];
export type ClassifierModel = typeof ALLOWED_CLASSIFIER_MODELS[number];

export interface TenantSettings {
  persona: {
    signature: string;
    tone: string;
    companyDescription: string;
  };
  classifier: {
    model: ClassifierModel;
    prompt: string | null;  // null = use default permissive prompt
  };
  reply: {
    model: ReplyModel;
  };
  retrieval: {
    similarityThreshold: number;
    topK: number;
  };
  polling: {
    intervalSeconds: number;
    autoSend: boolean;  // false = save as Gmail draft instead of sending
  };
  limits: {
    dailyEmailCap: number;       // max emails the bot processes per UTC day
    totalChunkCap: number;       // max chunks across all documents
    maxPdfBytes: number;
  };
}

export function defaultTenantSettings(): TenantSettings {
  return {
    persona: {
      signature: '— Sent by inbox-ai',
      tone: 'professional, warm, concise',
      companyDescription: '',
    },
    classifier: {
      model: 'openai/gpt-4o-mini',
      prompt: null,
    },
    reply: {
      model: 'deepseek/deepseek-v4-flash',
    },
    retrieval: {
      similarityThreshold: 0.3,
      topK: 5,
    },
    polling: {
      intervalSeconds: 60,
      autoSend: true,
    },
    limits: {
      dailyEmailCap: 200,
      totalChunkCap: 5000,
      maxPdfBytes: 25 * 1024 * 1024,
    },
  };
}

// Defensive: deep-merge persisted settings over defaults so a partial settings
// object in the DB (e.g. from a previous version) still produces a complete
// TenantSettings without missing keys at runtime.
export function withDefaults(partial: Partial<TenantSettings> | null | undefined): TenantSettings {
  const d = defaultTenantSettings();
  if (!partial) return d;
  return {
    persona: { ...d.persona, ...(partial.persona ?? {}) },
    classifier: { ...d.classifier, ...(partial.classifier ?? {}) },
    reply: { ...d.reply, ...(partial.reply ?? {}) },
    retrieval: { ...d.retrieval, ...(partial.retrieval ?? {}) },
    polling: { ...d.polling, ...(partial.polling ?? {}) },
    limits: { ...d.limits, ...(partial.limits ?? {}) },
  };
}
