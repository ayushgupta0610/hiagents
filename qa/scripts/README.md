# qa/scripts

One-off investigation / verification scripts. **Not for prod** — they need
`.env.local` with `SUPABASE_SERVICE_ROLE_KEY` (full DB access) and
`OPENROUTER_API_KEY`. Run from the repo root with `npx tsx`.

| Script | What it does |
|---|---|
| `inspect-usage.ts <email>` | Dumps `llm_usage` rows for a Gmail address: live tenant breakdown, all-time across deleted tenants, platform-wide total. Useful for debugging "the dashboard says X but OpenRouter says Y" gaps. |
| `verify-deploy.ts` | Snapshot of `oauth_tokens.connected_at` watermark + recent `llm_usage` cost rows. Run after deploying a pricing or watermark change. |
| `verify-openrouter.ts` | Confirms OpenRouter returns `usage.cost` when `usage:{include:true}` is set, and prints current per-M prices for the models we use. |
| `verify-priceFor.ts` | End-to-end test of `src/providers/pricing.ts#priceFor` — catalog hit, FALLBACK_PRICING for embeddings, unknown-model behavior. |
| `find-cheaper-models.ts` | Scans the full OpenRouter catalog (~350 models), filters to reputable providers + adequate context, ranks the cheapest classifier and chat candidates. |
| `smoke-classifier.ts` | Quick smoke test of a candidate classifier model against ~8 cases. |
| `eval-classifier-full.ts` | Wider eval (24 cases) using the **exact** production prompts from `src/pipeline/{classifier,risk,moderate}.ts` — includes 10 critical-safety adversarial cases (prompt injection, wire fraud, etc.). Use this before any classifier-model swap. |
| `debug-gpt-oss.ts` | One-off: investigates why `openai/gpt-oss-20b` returns empty content (it's a reasoning model — answer is in the `reasoning` field). |
| `build-sample-kb.mjs` | Renders `tmp/sample-kb/aiagencycorp-services.html` → PDF for KB upload demos. Uses the Playwright already installed for the QA suite. |

## Conventions

- All TypeScript scripts use top-level await and `dotenv/config`; run with `npx tsx --env-file=.env.local qa/scripts/<file>.ts`.
- Scripts that take user input read from `process.argv` or env vars — don't hardcode emails or tenant IDs (this repo is public).
- Cost-checking scripts treat OpenRouter's `usage.cost` as the source of truth; anything else is a fallback.
