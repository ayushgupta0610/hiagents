# hiagents

> Self-hostable, multi-tenant AI inbox agent. Connects to Gmail, learns from your PDFs, replies in your voice. Built on Express + Supabase + pgvector + OpenRouter. MIT licensed.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](package.json)

> **The hosted version isn't open to everyone yet.** [Join the waitlist at hiagents.digital](https://www.hiagents.digital/) for early access — or self-host today (instructions below).

A single deployment serves N tenants. Sign in with Google, get an auto-provisioned workspace, drop in PDFs, and the bot starts answering unread mail in ~60 seconds. It's a RAG pipeline on Gmail OAuth with the production bits most demos skip: graceful SIGTERM drain, per-tenant cost tracking, header sanitization, AES-256-GCM OAuth tokens at rest, and row-level tenant isolation.

## What's in the box

- **Gmail-native poller** — node-cron 60s tick, 10 tenants in parallel, graceful drain on SIGTERM.
- **PDF RAG** — drag in PDFs, chunk + embed, retrieve via pgvector. Below similarity threshold → no reply (no hallucination).
- **Two-stage classification** — cheap intent classifier + parallel risk classifier (abuse / prompt-injection / fraud). Either fires → skip.
- **Outbound moderation** — final pass blocks toxic, legally-risky, or PII-leaking replies before send.
- **Multi-tenant isolation** — every query scoped by `tenant_id`; Postgres RLS as defense-in-depth; regression test in `tests/integration/tenant-isolation.test.ts`.
- **Security primitives** — AES-256-GCM tokens at rest, HMAC session cookies with server-side max-age, CSRF double-submit, OAuth state nonce, header sanitization on outbound mail.
- **Per-tenant cost tracking** — every LLM call writes `{tenant_id, model, tokens, cost_usd}`; spend caps enforced before each call.

## Quick start

You'll need a Supabase project, an OpenRouter API key, and a Google OAuth client.

```bash
git clone https://github.com/ayushgupta0610/hiagents.git
cd hiagents
npm install
cp .env.example .env       # fill in values; generation commands inline
npm run dev                # :3000
```

- **Supabase** — paste `supabase/migrations/001_init.sql` then `002_multi_tenant.sql` into the SQL editor.
- **OpenRouter** — get an API key from openrouter.ai. Defaults: `gpt-4o-mini` for the classifier, DeepSeek for replies.
- **Google OAuth** — see [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md).
- **Secrets** — `SESSION_SECRET` (≥32 chars) and `TOKEN_ENCRYPTION_KEY` (32 bytes base64). Generation commands inline in `.env.example`.

Open `http://localhost:3000/admin/login`, sign in with Google, walk through the wizard, drop in some PDFs, send yourself a test email from another account.

## Deploy

Long-lived Node process behind nginx + pm2, or Docker Compose. **Not serverless** — the cron poller, cleanup job, in-process caches, and SIGTERM drain all fight serverless head-on.

```bash
docker compose up -d --build
```

For hand-tuned production deploys:

- [docs/DEPLOY.md](docs/DEPLOY.md) — VPS prep, env, DNS, TLS, pm2
- [docs/MULTI-DEPLOYMENT.md](docs/MULTI-DEPLOYMENT.md) — multiple isolated instances on one VPS
- [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md) — Google Cloud + OAuth consent + verification

## How a reply gets made

Per tenant, on each poll tick:

1. **Skip** auto-generated mail, system senders, and threads where the owner already replied.
2. **Classify + risk-check** in parallel — cheap LLM calls. Either fires → skip.
3. **Retrieve** — pgvector top-k from `kb_chunks`, scoped by tenant. Below threshold → `no-kb-match`.
4. **Generate** — reply model drafts from retrieved chunks + persona settings. KB context treated as untrusted.
5. **Moderate + send** — final safety pass, then Gmail API in-thread (sanitized headers).
6. **Audit** — `messages` row per email + `llm_usage` row per LLM call.

## Architecture

```
HTTP (express) ─┬─ /admin/*             dashboard + KB + activity
                ├─ /admin/api/settings  per-tenant settings (Zod-validated)
                ├─ /admin/onboarding    4-step wizard
                ├─ /oauth/*             Google sign-in + Gmail mailbox-connect
                └─ /health

Cron (node-cron) ── workers/poller.ts ── every POLL_INTERVAL_SECONDS (default 60)
                                          └─ runWithConcurrency(10, processTenant)

Cron (node-cron) ── workers/cleanup.ts ── daily 03:00 UTC

Data (Supabase Postgres + pgvector):
  tenants, memberships, oauth_tokens, kb_documents, kb_chunks,
  messages, llm_usage, audit_log — every per-tenant table has tenant_id + RLS
```

Deeper notes in [CLAUDE.md](CLAUDE.md). Feature inventory in [docs/FEATURES.md](docs/FEATURES.md). Security model in [docs/SAFETY-AUDIT.md](docs/SAFETY-AUDIT.md).

## Tests

```bash
npm test                      # unit + offline integration
TEST_SUPABASE=1 npm test      # also runs tenant-isolation (real Supabase test project)
```

E2E suite (Playwright headed Chrome): see [qa/README.md](qa/README.md).

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the patterns we follow. For non-trivial changes, open an issue first.

## License

MIT — see [LICENSE](LICENSE).
