import 'dotenv/config';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('missing OPENROUTER_API_KEY');

async function call(model: string, maxTokens: number, extra: Record<string, unknown> = {}) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'hiagents-debug' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      usage: { include: true },
      messages: [
        { role: 'system', content: 'reply with exactly the word PING' },
        { role: 'user', content: 'hello' },
      ],
      ...extra,
    }),
  });
  const json = await res.json();
  console.log(`\n=== model=${model} maxTokens=${maxTokens} extra=${JSON.stringify(extra)}`);
  console.log(JSON.stringify(json, null, 2));
}

await call('openai/gpt-oss-20b', 5);
await call('openai/gpt-oss-20b', 256);
await call('openai/gpt-oss-20b', 256, { reasoning: { exclude: true } });
