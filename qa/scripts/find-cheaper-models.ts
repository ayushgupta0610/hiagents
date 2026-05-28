import 'dotenv/config';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('missing OPENROUTER_API_KEY');

interface RawModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

const res = await fetch('https://openrouter.ai/api/v1/models', {
  headers: { Authorization: `Bearer ${key}` },
});
const json = (await res.json()) as { data: RawModel[] };
const all = json.data ?? [];
console.log(`total models in catalog: ${all.length}\n`);

// helper: cost per million tokens
const perM = (s?: string): number => (s ? Number(s) * 1_000_000 : NaN);

// CURRENT MODELS
console.log('=== current models in use ===');
const current = ['openai/gpt-4o-mini', 'deepseek/deepseek-v4-flash', 'openai/text-embedding-3-small', 'anthropic/claude-haiku-4.5'];
for (const id of current) {
  const m = all.find((x) => x.id === id);
  if (!m) {
    console.log(`  ${id.padEnd(40)} NOT IN CATALOG`);
    continue;
  }
  console.log(`  ${id.padEnd(40)} prompt=$${perM(m.pricing?.prompt).toFixed(3).padStart(8)}/M  completion=$${perM(m.pricing?.completion).toFixed(3).padStart(8)}/M  ctx=${m.context_length}`);
}

// score: typical email-classifier cost = 500 prompt + 10 completion
// score: typical chat-reply cost     = 2000 prompt + 300 completion
const scoreClassifier = (m: RawModel): number => 500 * (Number(m.pricing?.prompt ?? Infinity)) + 10 * (Number(m.pricing?.completion ?? Infinity));
const scoreChat = (m: RawModel): number => 2000 * (Number(m.pricing?.prompt ?? Infinity)) + 300 * (Number(m.pricing?.completion ?? Infinity));

// Filter: text-only chat models, not free (free = "training data" risk), reasonable size
const isUsableChat = (m: RawModel): boolean => {
  const promptCost = Number(m.pricing?.prompt ?? 0);
  const completionCost = Number(m.pricing?.completion ?? 0);
  if (!Number.isFinite(promptCost) || !Number.isFinite(completionCost)) return false;
  if (promptCost === 0 && completionCost === 0) return false; // free-tier — usually has privacy / rate-limit downsides
  const inputs = m.architecture?.input_modalities ?? [];
  const outputs = m.architecture?.output_modalities ?? [];
  if (inputs.length && !inputs.includes('text')) return false;
  if (outputs.length && !outputs.includes('text')) return false;
  if ((m.context_length ?? 0) < 8000) return false; // need at least 8k for our prompts + RAG context
  if (Number(m.pricing?.request ?? 0) > 0) return false; // skip per-request-fee models
  if (Number(m.pricing?.image ?? 0) > 0) return false; // skip image-fee models
  return true;
};

// reputable provider whitelist — we don't want to recommend random fly-by-night models
// for a production B2B SaaS where the user's brand voice goes out over their email
const REPUTABLE = /^(openai|anthropic|google|meta-llama|mistralai|deepseek|qwen|x-ai|nvidia|cohere|amazon)\//;

console.log('\n=== cheapest CLASSIFIER candidates (500 in + 10 out tokens, reputable providers, ≥8k ctx) ===');
const cheapClassifiers = all
  .filter(isUsableChat)
  .filter((m) => REPUTABLE.test(m.id))
  .sort((a, b) => scoreClassifier(a) - scoreClassifier(b))
  .slice(0, 15);
for (const m of cheapClassifiers) {
  console.log(`  ${m.id.padEnd(45)} prompt=$${perM(m.pricing?.prompt).toFixed(4).padStart(8)}/M  completion=$${perM(m.pricing?.completion).toFixed(4).padStart(8)}/M  per-call=$${(scoreClassifier(m)).toExponential(2).padStart(10)}  ctx=${m.context_length}`);
}

console.log('\n=== cheapest CHAT candidates (2000 in + 300 out tokens, reputable providers, ≥16k ctx) ===');
const cheapChats = all
  .filter((m) => isUsableChat(m) && (m.context_length ?? 0) >= 16000)
  .filter((m) => REPUTABLE.test(m.id))
  .sort((a, b) => scoreChat(a) - scoreChat(b))
  .slice(0, 15);
for (const m of cheapChats) {
  console.log(`  ${m.id.padEnd(45)} prompt=$${perM(m.pricing?.prompt).toFixed(4).padStart(8)}/M  completion=$${perM(m.pricing?.completion).toFixed(4).padStart(8)}/M  per-call=$${(scoreChat(m)).toExponential(2).padStart(10)}  ctx=${m.context_length}`);
}

console.log('\n=== embedding models available in OpenRouter catalog ===');
const embeddings = all.filter((m) => /embed/i.test(m.id) || /embed/i.test(m.name ?? ''));
if (embeddings.length === 0) {
  console.log('  none found in catalog (OpenRouter exposes only chat models — embeddings go through /api/v1/embeddings)');
} else {
  for (const m of embeddings) {
    console.log(`  ${m.id.padEnd(40)} prompt=$${perM(m.pricing?.prompt).toFixed(4).padStart(8)}/M`);
  }
}
