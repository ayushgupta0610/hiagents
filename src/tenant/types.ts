// src/tenant/types.ts

// Model selection is operator-controlled, not per-tenant. The fixed
// defaults live in defaultTenantSettings() below; tenants don't pick
// (no dropdown in the UI, no `reply.model` / `classifier.model` in the
// settings PUT schema). To change the model used, edit the defaults
// here and redeploy.
//
// The `string` types are kept (rather than literal unions) so historical
// settings rows written before this change still type-check on read.
export type ReplyModel = string;
export type ClassifierModel = string;

export interface TenantSettings {
  persona: {
    signature: string;
    tone: string;
    companyDescription: string;
    // True once the user has explicitly submitted the persona step at least
    // once during onboarding. Used to drive the onboarding "step done?"
    // computation independently of the (now-optional) companyDescription
    // field, so users who keep all defaults can still progress past Persona.
    configured: boolean;
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
    autoSend: boolean;  // false = save reply as draft only, don't actually send
    paused: boolean;    // operator kill switch — poller skips this tenant entirely
  };
  limits: {
    dailyEmailCap: number;       // max emails the bot processes per UTC day
    perSenderDailyReplyCap: number; // max bot replies to one sender per UTC day
    totalChunkCap: number;       // max chunks across all documents
    maxPdfBytes: number;
    dailySpendCapUsd: number;    // max USD of LLM spend per UTC day before bot pauses
  };
}

export function defaultTenantSettings(): TenantSettings {
  return {
    persona: {
      signature: '— Sent by hiagents',
      tone: 'professional, warm, concise',
      companyDescription: '',
      configured: false,
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
      paused: false,
    },
    limits: {
      dailyEmailCap: 200,
      perSenderDailyReplyCap: 15,
      totalChunkCap: 5000,
      maxPdfBytes: 25 * 1024 * 1024,
      dailySpendCapUsd: 5,
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
