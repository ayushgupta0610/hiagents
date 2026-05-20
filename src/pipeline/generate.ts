import { chat } from '../providers/openrouter.js';
import type { RetrievedChunk, IncomingEmail } from '../types.js';
import type { TenantSettings } from '../tenant/types.js';

export interface GenerateInput {
  tenantId: string;
  settings: TenantSettings;
  email: IncomingEmail;
  chunks: RetrievedChunk[];
}

const SYSTEM_TEMPLATE = (tone: string, company: string, signature: string) =>
  `You are an email assistant replying on behalf of ${company || 'the recipient'}. Tone: ${tone}.

Rules:
- Answer ONLY using the provided knowledge base context. If the context does not cover the question, say so politely and offer to follow up — do NOT invent facts.
- Address the sender by name if their name is in the email; otherwise no greeting name.
- Keep replies under 200 words unless the question genuinely requires more.
- No markdown, no bullet lists unless the original email used them. Plain prose, short paragraphs.
- End with this exact signature on its own line:
${signature}`;

function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => `[Source ${i + 1} (similarity ${c.similarity.toFixed(2)})]\n${c.content}`)
    .join('\n\n---\n\n');
}

export async function generateReply(input: GenerateInput): Promise<string> {
  const { persona } = input.settings;
  const system = SYSTEM_TEMPLATE(persona.tone, persona.companyDescription, persona.signature);
  const context = buildContextBlock(input.chunks);
  const userPrompt = `Knowledge base context:
${context}

---

Incoming email:
From: ${input.email.from}
Subject: ${input.email.subject}

${input.email.bodyText}

---

Write the reply now. Plain text only.`;

  return await chat({
    model: input.settings.reply.model,
    temperature: 0.3,
    maxTokens: 800,
    tenantId: input.tenantId,
    kind: 'chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  });
}
