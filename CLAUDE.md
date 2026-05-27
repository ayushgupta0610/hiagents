# CLAUDE.md — hiagents

Guidance for AI agents and human contributors working in this repo. Read this
before making changes — the "Things to NOT reintroduce" section captures
decisions we've already made and don't want to re-litigate by accident.

## What this repo is

**hiagents** is a multi-tenant SaaS application that auto-replies to inbound
email using a PDF-backed knowledge base. The first (and currently only) agent
is **Inbox**. One deployment serves N tenants — anyone with a Google account
can sign in, gets an auto-provisioned workspace, connects Gmail, drops in
PDFs, and the bot starts replying within ~60 seconds.

The repo folder + git remote are historically named `inbox-ai`; the user-facing
brand is `hiagents`. The two will coexist forever in that split — don't try to
rename the repo or the pm2 process to "match" the brand.

## Run / build / test

```bash
npm install           # Node 20+
npm run dev           # tsx watch src/server.ts
npm run build         # tsc + copy src/ui → dist/ui
npm test              # vitest run (unit + integration; see "Tests" below)
```

## Architecture in one screen

```
HTTP (express) ─┬─ /admin/*             src/routes/admin.ts        dashboard + KB upload + activity
                ├─ /admin/api/settings  src/routes/settings.ts     per-tenant settings (Zod-validated)
                ├─ /admin/onboarding    src/routes/onboarding.ts   4-step wizard
                ├─ /oauth/*             src/routes/oauth.ts        Google sign-in + Gmail mailbox-connect
                └─ /health              src/routes/health.ts

Cron (node-cron) ── src/workers/poller.ts ── runs every POLL_INTERVAL_SECONDS
                                              ├─ listOnboardedTenants() — slim projection (id + settings)
                                              ├─ runWithConcurrency(POLL_CONCURRENCY=10, processTenant)
                                              └─ processTenant → listUnreadInbox → for each: fetchMessage → runPipeline

Cron (node-cron) ── src/workers/cleanup.ts ── daily 03:00 UTC, hard-deletes soft-deleted tenants > 30d

Pipeline (src/pipeline/run.ts):
  loop-guard → thread-guard → assertEmailQuota → isFromSelf / isSystemSender →
  assertPerSenderReplyQuota → assertDailySpendCap → fetchThreadMessages →
  Promise.all([classify, assessInboundRisk]) → search (pgvector) →
  generateReply → moderateOutbound → sendReply → write `messages` row

Data (Supabase Postgres):
  tenants, memberships, oauth_tokens, kb_documents, kb_chunks (pgvector),
  messages, llm_usage, audit_log  — every per-tenant table has `tenant_id` + RLS
```

## Things to NOT reintroduce

Each of these has been intentionally removed or deliberately never added. If
you find yourself about to add one back, check `docs/FEATURES.md` /
`docs/SAFETY-AUDIT.md` first — there's usually a "🚫 Removed YYYY-MM-DD —
reason" line explaining why.

- **Gmail labels** (`hiagents/replied`, `…/skipped`, `…/failed`). The poller
  used to apply these; we removed them because they pollute the user's mailbox
  visually. The same status info is on each `messages` row + the Activity
  dashboard.
- **`markRead`** on processed emails. Same reason as labels but worse —
  silently changing the unread count messes with the user's primary inbox
  signal. Dedupe is handled by `runPipeline`'s `messages.gmail_message_id`
  idempotency check.
- **Per-tenant model dropdown** (reply / classifier model). Deployment-wide
  in `defaultTenantSettings()`. Predictable cost + quality across the
  platform.
- **Per-tenant retrieval-tuning UI** (similarity threshold + top-K).
  Operator knobs, not user-facing decisions. Defaults of 0.3 / 5 work for
  everyone. The Zod schema still accepts them via direct PUT for operators
  who want to override.
- **`ADMIN_PASSWORD` / password-fallback login**. Google sign-in is the only
  path in. Use `SESSION_SECRET` for HMAC and `TOKEN_ENCRYPTION_KEY` for
  AES-256-GCM token-at-rest.
- **`inbox-ai` brand in user-facing copy**. Renamed to `hiagents` everywhere
  the user sees text. Cookies are `hiagents_admin` / `hiagents_csrf` /
  `hiagents_oauth_state`. Log service is `hiagents`. The repo folder + git
  remote still say `inbox-ai` historically — that's the only place it should
  remain.
- **Blanket "no code / shell commands" rule in the moderator**. False-positives
  on legitimate devtools answers. The current rule is specific — remote-exec
  pipes, destructive commands, credential exfiltration. See "Moderation
  calibration" in `docs/SAFETY-AUDIT.md`.

## Patterns to follow

- **Error envelope**: every JSON API failure goes through `sendError(res,
  status, { code, message, internal? })` from `src/lib/errors.ts`. Never
  `res.status(500).json({ error: e.message })` — that leaks stack traces. The
  UI's `safeFetch` in `admin.html` / `onboarding.html` reads `message` and
  shows it verbatim, so write messages for end-users, not developers.
- **Audit writes from routes**: use `auditFireAndForget(...)` (not
  `await audit(...)`) in request handlers — keeps responses fast. The original
  `audit(...)` is for cron / batch paths where the surrounding process might
  exit before a detached write would land.
- **CSRF**: every state-changing route (POST/PUT/DELETE) must have the
  `csrfGuard` middleware after `requireAdmin`. The UI's `safeFetch` echoes
  the cookie automatically; no per-call work needed on the client.
- **Header sanitization on outbound mail**: anything that ends up in a raw
  RFC 2822 header MUST go through `sanitizeHeader()` / `sanitizeMessageId()`
  in `src/providers/gmail.ts`. Don't string-interpolate user-controlled
  values into header lines.
- **Token storage**: never read or write `oauth_tokens.access_token` /
  `refresh_token` without going through `encryptToken` / `decryptToken` in
  `src/lib/crypto.ts`. The format is `v1:base64(iv || tag || ciphertext)`
  with random per-encrypt IV. Legacy plaintext rows (no `v1:` prefix) are
  opportunistically re-encrypted on next read by `loadStoredTokensForTenant`.
- **Tenant scoping**: every query that touches a per-tenant table is filtered
  by `tenant_id` in code. RLS is on as defense-in-depth but app-code paths
  use the service role key (bypasses RLS). Use `tenantScoped()` in
  `src/tenant/scoped.ts` where it fits; integration test in
  `tests/integration/tenant-isolation.test.ts` verifies isolation under
  `TEST_SUPABASE=1`.
- **In-process caches** (tenant lookup 30s TTL, undici socket pool 32/origin):
  both invalidate / cap correctly already. If you add new caches, document
  the TTL and the invalidation hook.

## Deploy domain

The canonical hostname is stored in `.deploy-domain` and used in docs +
examples + `.env.example`. To swap to a different hostname:

```bash
scripts/set-deploy-domain.sh app.example.com
```

The script handles three patterns in one pass — singleton, multi-client dash
(`bot-acme.…`), multi-client placeholder (`bot.<client-slug>.…`) — and
updates `.env.example`, `README.md`, `docs/DEPLOY.md`,
`docs/GMAIL-OAUTH-SETUP.md`, `docs/nginx-vhost.conf.example`. Runtime config
is env-driven (`BASE_URL` / `DOMAIN` / `GOOGLE_REDIRECT_URI`) and intentionally
untouched — update `.env` on the deployment separately.

## Onboarding

4 visible steps: **Set up → Gmail → Knowledge → Review**. The "Set up" card
combines workspace name + persona + classifier prompt into one form with one
Continue button (POSTs fired in parallel). Workspace name is the only required
field; everything else is optional with sensible defaults. See
`docs/ONBOARDING-FLOW.md` for the routing logic + step-done computation table.

`tenant.settings.persona.configured: boolean` is set by the persona POST and
is what drives `steps.persona = true` — don't tie that flag to
`companyDescription` again (it's optional now).

## Security model

Most of this is detailed in `docs/SAFETY-AUDIT.md`. The session-state primitives:

- **Session cookie** `hiagents_admin` — HMAC-SHA256, 7-day server-side
  max-age check (rejects leaked-but-unrotated cookies even if HMAC valid).
- **CSRF cookie** `hiagents_csrf` (non-httpOnly) — HMAC-signed nonce echoed
  via `X-CSRF-Token` header.
- **OAuth state cookie** `hiagents_oauth_state` (httpOnly, 10-min, `/oauth`
  path) — defends `/oauth/callback` against forged-callback phishing.
- **AES-256-GCM at rest** for OAuth tokens via `src/lib/crypto.ts`.

## pm2

The pm2 process name in `ecosystem.config.cjs` is `inbox-ai`, not `hiagents`.
The operational identifiers (repo folder, git remote, pm2 name) kept their
old `inbox-ai` names; only the user-facing brand changed to `hiagents`.
Renaming would either need a manual `pm2 delete inbox-ai && pm2 start …`
(downtime) or silently spawn a second process. Not worth it.

If you run multiple deployments side-by-side on the same VPS (e.g. one per
domain), each clone gets its own pm2 name — see `docs/MULTI-DEPLOYMENT.md`.

`kill_timeout: 20000` in the manifest must be ≥ `SHUTDOWN_TIMEOUT_MS`
(15000) in `src/server.ts`, otherwise pm2 will SIGKILL mid-drain on
`pm2 reload`. The server installs SIGTERM + SIGINT handlers that stop
accepting new connections and drain in-flight requests for up to 15s
before exiting.

## Hosting model

**This app runs on a long-lived Node process behind nginx + pm2 (or Docker
Compose). Do not propose moving it to Vercel / Cloudflare Workers / any
serverless target.** Three things in the codebase fight serverless head-on:
the `node-cron` mailbox poller (continuous 60s loop), the daily cleanup
cron, and the in-process caches + SIGTERM graceful drain. Moving to
serverless would mean rewriting roughly 40% of the backend.

## Tests

`npm test` runs vitest. Notable:

- `tests/integration/safety-guards.test.ts` makes live LLM calls (requires
  `.env.local` with real `OPENROUTER_API_KEY` + Supabase). Skipped by default
  in CI; runs locally when those are set.
- `tests/unit/crypto.test.ts` requires `TOKEN_ENCRYPTION_KEY` to be
  **exactly 32 bytes** base64-decoded. If you see crypto failures, your local
  env has a wrong-sized key — regenerate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- `tests/integration/tenant-isolation.test.ts` runs under `TEST_SUPABASE=1`
  against a real Supabase test project.

When you change `src/pipeline/moderate.ts` (especially adding / removing
rules), add a matching integration test case — both an OK case and a FLAGGED
case — so we don't drift back into false-positives.

QA suite (Playwright headed Chrome) lives in `qa/`: see `qa/README.md` for
the auth-gated dashboard + onboarding end-to-end tests.
