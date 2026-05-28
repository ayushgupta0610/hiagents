import 'dotenv/config';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('missing OPENROUTER_API_KEY');

console.log('=== chat with usage:{include:true} — does OpenRouter return cost? ===');
const chatRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    'X-Title': 'hiagents-verify',
  },
  body: JSON.stringify({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'reply with exactly the word OK' }],
    max_tokens: 5,
    usage: { include: true },
  }),
});
const chatJson = await chatRes.json();
console.log('chat usage field:', JSON.stringify(chatJson.usage, null, 2));

console.log('\n=== /api/v1/models — what are the actual prices for the models we use? ===');
const modelsRes = await fetch('https://openrouter.ai/api/v1/models', {
  headers: { Authorization: `Bearer ${key}` },
});
const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
const wanted = new Set([
  'openai/gpt-4o-mini',
  'deepseek/deepseek-v4-flash',
  'openai/text-embedding-3-small',
  'anthropic/claude-haiku-4.5',
]);
for (const m of modelsJson.data ?? []) {
  if (wanted.has(m.id)) {
    const promptPerM = Number(m.pricing?.prompt ?? 0) * 1_000_000;
    const completionPerM = Number(m.pricing?.completion ?? 0) * 1_000_000;
    console.log(`  ${m.id.padEnd(35)} prompt=$${promptPerM.toFixed(4)}/M  completion=$${completionPerM.toFixed(4)}/M`);
  }
}

const hardcodedOld = {
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'deepseek/deepseek-v4-flash': { input: 0.112, output: 0.224 },
  'openai/text-embedding-3-small': { input: 0.02, output: 0 },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
};
console.log('\n  for comparison — old hardcoded table (per M tokens):');
for (const [m, p] of Object.entries(hardcodedOld)) {
  console.log(`    ${m.padEnd(35)} prompt=$${p.input.toFixed(4)}/M  completion=$${p.output.toFixed(4)}/M`);
}
