export type ClassifierVerdict = 'client_query' | 'other';

export interface ClassifierInput {
  from: string;
  subject: string;
  bodyText: string;
}

const SYSTEM_PROMPT = `You classify whether an incoming email is a client/customer query that an AI agency should respond to, or something else (newsletter, automated notification, internal team message, spam, personal mail).

Match (CLIENT_QUERY): questions about services, pricing, demo requests, support questions, project inquiries, follow-ups from prospects.
Skip (OTHER): newsletters, marketing blasts, transactional/receipt emails, automated notifications, internal team chatter, personal mail not related to business.

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

export async function classify(input: ClassifierInput): Promise<ClassifierVerdict> {
  const { env } = await import('../config.js');
  const { chat } = await import('../providers/openrouter.js');
  return classifyWith(async (userPrompt) => {
    return await chat({
      model: env.CLASSIFIER_MODEL,
      temperature: 0,
      maxTokens: 5,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
  }, input);
}
