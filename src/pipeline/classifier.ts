export type ClassifierVerdict = 'client_query' | 'other';

export interface ClassifierInput {
  from: string;
  subject: string;
  bodyText: string;
}

export const DEFAULT_CLASSIFIER_PROMPT = `You classify whether an incoming email contains a genuine question worth answering from a knowledge base, or something else (newsletter, automated notification, no-question chatter, spam).

Reply CLIENT_QUERY if the email contains ANY of:
- A direct question (what, how, when, why, can you, could you, do you, please tell me)
- A request for information about a topic, product, command, feature, or capability
- An inquiry about pricing, services, demos, or how something works
- A follow-up to a prior conversation that includes a question

Reply OTHER only if the email is clearly:
- A newsletter, marketing blast, or promotional content
- An automated transactional notification (receipts, order confirmations, deploy alerts)
- A no-content message with no question at all (e.g., "ok", "thanks", "got it")
- Spam or unsolicited mail
- An automated reply / out-of-office message

When in doubt, lean CLIENT_QUERY. False positives (replying to a non-question) are cheaper than false negatives (missing a real customer or test).

Reply with exactly one word: CLIENT_QUERY or OTHER. No punctuation, no explanation.`;

function buildUserPrompt(input: ClassifierInput): string {
  const body = input.bodyText.slice(0, 2000);
  return `From: ${input.from}\nSubject: ${input.subject}\n\n${body}`;
}

export async function classifyWith(
  llm: (prompt: string) => Promise<string>,
  input: ClassifierInput,
): Promise<ClassifierVerdict> {
  const prompt = buildUserPrompt(input);
  const raw = await llm(prompt);
  const normalized = raw.trim().toLowerCase();
  return normalized === 'client_query' ? 'client_query' : 'other';
}

export async function classify(
  tenantId: string,
  settings: import('../tenant/types.js').TenantSettings,
  input: ClassifierInput,
): Promise<ClassifierVerdict> {
  const { chat } = await import('../providers/openrouter.js');
  const systemPrompt = settings.classifier.prompt?.trim() || DEFAULT_CLASSIFIER_PROMPT;
  return classifyWith(async (userPrompt) => {
    return await chat({
      model: settings.classifier.model,
      temperature: 0,
      maxTokens: 5,
      tenantId,
      kind: 'classifier',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
  }, input);
}
