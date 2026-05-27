# hiagents

> Self-hostable, multi-tenant AI inbox agent. Connects to Gmail, learns from PDFs you upload, replies to customers in your voice. Built on Express + Supabase + pgvector + OpenRouter. Open source under MIT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](package.json)

A single deployment serves N tenants. Anyone signs in with Google, gets an auto-provisioned workspace, uploads PDFs, and the bot starts answering their unread mail within 60 seconds. It's a working RAG pipeline glued to Gmail OAuth, with the production bits most demos skip: graceful SIGTERM drain, per-tenant cost tracking, header sanitization, AES-256-GCM OAuth tokens at rest, and row-level tenant isolation.

## Why this exists

Built to learn the production end of an AI feature: retrieval that actually works, eval pipelines, the messy parts of OAuth, multi-tenant safety. It works well enough to use, so it's open source. Fork it, run it for your support inbox, take the pieces you want, or use it as a reference for the parts most tutorials skip.

## What's in the box

- **Gmail-native poller.** node-cron tick every 60s. Processes up to 10 tenants concurrently. Drains gracefully on SIGTERM so `pm2 reload` doesn't leave half-handled messages.
- **PDF RAG.** Drag PDFs into the admin UI → text extraction → pgvector chunks → retrieval with per-tenant similarity threshold. If nothing scores above threshold, the bot does NOT reply (logged as `no-kb-match`).
- **Two-stage classification.** Cheap classifier labels intent; a parallel risk classifier flags abuse / prompt-injection / fraud language. Either fires → skip. Cheap pre-filter before the expensive reply call.
- **Outbound moderation.** Final pass blocks toxic, legally-risky, or PII-leaking replies before send.
- **Multi-tenant isolation.** Every query scoped by `tenant_id` in app code; Postgres RLS on every per-tenant table as defense-in-depth.
- **Security primitives.** AES-256-GCM token-at-rest, HMAC-signed session cookies (7-day server-side max-age), CSRF double-submit, OAuth state nonce, header sanitization on outbound mail (`To` / `Subject` / `In-Reply-To`).
- **Per-tenant cost attribution.** Every `chat()` and `embed()` call writes `{tenant_id, model, kind, tokens, cost_usd}` to `llm_usage`. Spend caps enforced before each LLM call.

## Quick start (local)

You'll need a Supabase project, an OpenRouter API key, and a Google OAuth client.

```bash
git clone <your-fork-url> hiagents
cd hiagents
npm install
cp .env.example .env       # fill in the values; generation commands inline
npm run dev                # tsx watch src/server.ts on :3000
```

**Supabase:** create a new project, paste `supabase/migrations/001_init.sql` then `supabase/migrations/002_multi_tenant.sql` into the SQL editor and run each. Note your project URL and `service_role` key.

**OpenRouter:** sign up at openrouter.ai, grab an API key. Defaults use `openai/gpt-4o-mini` for the classifier (cheap) and `deepseek/deepseek-v4-flash` for replies. You can change either in `src/tenant/types.ts → defaultTenantSettings()`.

**Google OAuth:** see [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md). You'll need a Web-application OAuth client with `http://localhost:3000/oauth/callback` in the redirect URIs and your Gmail on the Test Users list.

**Two random secrets** — `SESSION_SECRET` (≥32 chars) and `TOKEN_ENCRYPTION_KEY` (32 bytes base64). Generation commands inline in `.env.example`.

Open `http://localhost:3000/admin/login`, sign in with Google, walk through the wizard, drop in some PDFs, send yourself a test email from another account.

## Deploy

A long-lived Node process behind nginx + pm2 (or just Docker Compose) is the supported path. **Not** serverless — the cron poller, cleanup job, in-process caches, and SIGTERM drain all fight serverless head-on.

Simplest path:

```bash
docker compose up -d --build
```

For a hand-tuned production deploy (pm2, nginx vhost, OAuth verification, multi-instance per VPS, soft-delete cleanup), see:

- [docs/DEPLOY.md](docs/DEPLOY.md) — single-deployment runbook (VPS prep, env, DNS, TLS, pm2)
- [docs/MULTI-DEPLOYMENT.md](docs/MULTI-DEPLOYMENT.md) — running multiple isolated instances on one VPS
- [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md) — Google Cloud console + OAuth consent screen + verification

## How a reply gets made

Per tenant, on each poll tick:

1. **Loop guard** — skip auto-generated mail (newsletters, list mail) and system senders (mailer-daemon, no-reply, postmaster).
2. **Thread guard** — skip if the owner already replied to the thread manually.
3. **Classifier + risk** (parallel) — cheap LLM labels intent; risk classifier flags abuse / fraud / prompt-injection. Either fires → skip.
4. **Retrieve** — embed subject + first 1000 chars → pgvector top-k from `kb_chunks`, scoped by tenant. Below threshold → no-reply (`no-kb-match`).
5. **Generate** — reply model drafts a response grounded in retrieved chunks + the tenant's persona settings. System prompt treats KB context as untrusted data.
6. **Moderate** — final pass blocks toxic, legally-risky, or PII-leaking replies.
7. **Send** — Gmail API sends in-thread, with header sanitization on `To` / `Subject` / `In-Reply-To`.
8. **Audit** — every decision written to `messages` (scoped to tenant); every LLM call written to `llm_usage` for cost attribution.

## Architecture in one screen

```
HTTP (express) ─┬─ /admin/*             dashboard + KB upload + activity
                ├─ /admin/api/settings  per-tenant settings (Zod-validated)
                ├─ /admin/onboarding    4-step wizard
                ├─ /oauth/*             Google sign-in + Gmail mailbox-connect
                └─ /health

Cron (node-cron) ── workers/poller.ts ── every POLL_INTERVAL_SECONDS (default 60)
                                          ├─ listOnboardedTenants() — slim projection
                                          ├─ runWithConcurrency(POLL_CONCURRENCY=10)
                                          └─ processTenant → listUnreadInbox → runPipeline

Cron (node-cron) ── workers/cleanup.ts ── daily 03:00 UTC, hard-deletes soft-deleted tenants > 30d

Data (Supabase Postgres + pgvector):
  tenants, memberships, oauth_tokens, kb_documents, kb_chunks,
  messages, llm_usage, audit_log — every per-tenant table has tenant_id + RLS
```

Deeper architectural notes in [CLAUDE.md](CLAUDE.md). Per-feature inventory + roadmap in [docs/FEATURES.md](docs/FEATURES.md). Security model walkthrough in [docs/SAFETY-AUDIT.md](docs/SAFETY-AUDIT.md).

## Tests

```bash
npm test                      # unit + integration suites
TEST_SUPABASE=1 npm test      # also run tenant-isolation integration (needs a Supabase test project)
```

Unit tests are fast and offline. Integration tests that hit OpenRouter or Supabase are skipped by default; they run when their env vars are set.

QA suite (Playwright headed Chrome): see [qa/README.md](qa/README.md) for the auth-gated dashboard + onboarding end-to-end tests.

## Contributing

Issues and PRs welcome. Before submitting:

- Run `npm test` and `npm run build` locally.
- Keep new files focused — one clear responsibility, prefer <400 lines.
- Match existing patterns (error envelope via `sendError`, audit writes via `auditFireAndForget`, CSRF on every state-changing route — examples in [CLAUDE.md](CLAUDE.md) "Patterns to follow").
- For non-trivial changes, open an issue first to talk through approach.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the longer version.

## License

MIT — see [LICENSE](LICENSE).
