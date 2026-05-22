import { env } from '../config.js';
import { recordUsage } from '../tenant/usage.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tenantId?: string;
  kind?: 'chat' | 'classifier';
}

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function chat(opts: ChatOptions): Promise<string> {
  const body = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1024,
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': env.BASE_URL,
      'X-Title': 'hiagents',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }
  const json = (await res.json()) as OpenRouterResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');

  if (opts.tenantId) {
    await recordUsage({
      tenantId: opts.tenantId,
      model: opts.model,
      kind: opts.kind ?? 'chat',
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    });
  }

  return content;
}
