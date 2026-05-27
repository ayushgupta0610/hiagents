# Enterprise safety audit — hiagents email auto-reply

What is in place, what is missing, what to do about it. Categorised P0 / P1 / P2 by how badly an incident would hurt.

Last audit: 2026-05-21. Re-reviewed 2026-05-22 with most P0s + several P1s shipped (see Priority summary at bottom).

---

## 1. Loop protection (preventing bot-replies-to-bot)

| Control | Status | File / location |
|---|---|---|
| Skip inbound with `Auto-Submitted: auto-replied` / `auto-generated` | ✅ in place | `src/pipeline/loop-guard.ts` |
| Skip inbound with `X-Autoreply`, `X-Autorespond` headers | ✅ in place | same |
| Skip inbound with `Precedence: bulk / list / junk` (newsletters) | ✅ in place | same |
| Skip inbound with `List-Unsubscribe`, `List-Id` (mailing lists) | ✅ in place | same |
| Set `Auto-Submitted: auto-replied` on outgoing replies | ✅ in place | `src/providers/gmail.ts` `OUTGOING_LOOP_HEADERS` |
| Set `X-Autoreply: hiagents` on outgoing replies | ✅ in place | same |
| Skip mail from self (owner mailbox) | ✅ in place | `src/pipeline/run.ts` `isFromSelf()` |
| Skip thread if owner has manually replied | ✅ in place | `src/pipeline/thread-guard.ts` |
| System-sender deny list for `mailer-daemon@`, `postmaster@`, `noreply@`, `no-reply@`, `bounces@`, `abuse@` | ✅ in place | `src/pipeline/loop-guard.ts` `isSystemSender()` |
| Per-sender daily reply cap (configurable, default 5) | ✅ in place | `src/tenant/limits.ts` `assertPerSenderReplyQuota` |
| **MISSING:** rate-limit per-thread (cap total bot replies per thread) | ❌ P1 | — |

---

## 2. Rate limiting

| Control | Status | Where |
|---|---|---|
| Per-tenant daily email cap (default 200) | ✅ in place | `src/tenant/limits.ts` `assertEmailQuota` |
| Per-tenant chunk cap (default 5K) | ✅ in place | same `assertChunkCapacity` |
| Per-tenant PDF size cap (default 25MB) | ✅ in place | same `assertPdfSize` |
| Per-IP signin rate limit (5/hour) | ✅ in place | `src/routes/oauth.ts` `signinLimiter` |
| Per-sender daily reply cap | ✅ in place | `src/tenant/limits.ts` `assertPerSenderReplyQuota` |
| Per-tenant LLM spend cap ($/day, configurable in `tenants.settings.limits.dailySpendCapUsd`) | ✅ in place | `src/tenant/limits.ts` `assertDailySpendCap`, checked in `src/pipeline/run.ts` |
| Per-tenant concurrent-poll bound (cap 10 tenants per tick) | ✅ in place | `src/workers/poller.ts` |
| Body-size cap (256kb JSON; multer keeps 25MB for PDFs) | ✅ in place | `src/server.ts` |
| **MISSING:** rate-limit per-thread (cap total bot replies per thread) | ❌ P1 | — |
| **MISSING:** per-tenant KB upload rate limit (uploads/hour) | ❌ P1 | — |
| **MISSING:** burst protection on the poller (pause if any tenant suddenly produces 10x normal volume) | ❌ P1 | — |
| **MISSING:** API rate limits on `/admin/api/*` (per-cookie) | ❌ P2 | — |

**Risk-now (post-fix):** one abusive tenant still costs us money up to their `dailySpendCapUsd` ceiling every day before the cap fires. That's a bounded loss (default $5/tenant/day), but at 100 abusive tenants × 30 days = $15K/month in worst case. Mitigation: the `/oauth/signin` rate limit caps new-tenant creation at 5/IP/hour, and the signup audit log records IP for forensic follow-up.

---

## 3. Content safety (inbound)

| Control | Status | Where |
|---|---|---|
| Classifier filters out non-customer inbound | ✅ in place | `src/pipeline/classifier.ts` |
| Confidence gate (skip if KB has no close match) | ✅ in place | `src/pipeline/run.ts` (no-kb-match path) |
| Inbound risk classifier (profanity / abuse / threats / legal language / fraud / prompt-injection) | ✅ in place | `src/pipeline/risk.ts` (`assessInboundRisk`), called in parallel with the customer-query classifier in `src/pipeline/run.ts` |
| KB-context-as-untrusted-data in reply system prompt (model is explicitly told to never follow instructions inside KB chunks or the inbound email) | ✅ in place | `src/pipeline/generate.ts` SYSTEM_TEMPLATE |
| **MISSING:** PII detection on inbound (decide whether to log SSNs / credit cards into `messages.body_text`) | ❌ P1 | — |
| **MISSING:** language detection (only auto-reply in supported languages) | ❌ P1 | — |
| **MISSING:** attachment handling (incoming attachments are ignored; should be explicitly skipped + flagged) | ❌ P1 | — |

**Risk-now (post-fix):** the inbound risk classifier is an LLM judgment call — sophisticated prompt-injection or social engineering may slip through. The KB-as-untrusted system prompt is the second layer of defence: even if injection reaches the reply model, it's instructed to ignore directives in the user message. Both are heuristic, not bulletproof. Operator should still review activity for `risk-flag` skip reasons regularly.

---

## 4. Content safety (outbound)

| Control | Status | Where |
|---|---|---|
| System prompt instructs "answer only from KB, do not invent" | ✅ in place | `src/pipeline/generate.ts` SYSTEM_TEMPLATE |
| Reply length cap (800 max_tokens ≈ 600 words) | ✅ in place | same |
| Tenant signature appended | ✅ in place | same |
| Confidence gate prevents reply when no chunks above threshold | ✅ in place | `src/pipeline/run.ts` |
| Outbound moderation (toxicity, legal commitments, PII leakage, leaked-system-prompt detection) | ✅ in place | `src/pipeline/moderate.ts` (`moderateOutbound`); flagged replies log `reply_status='failed', reply_reason='content-flagged'` and are NOT sent |
| Header injection sanitization on `To` / `Subject` / `In-Reply-To` (strips CRLF / NUL, validates Message-ID shape) | ✅ in place | `src/providers/gmail.ts` `sanitizeHeader` + `sanitizeMessageId` |
| Moderation prompt is built per-call with `tenant.settings.persona.companyDescription` interpolated near the top — so the moderator can tell legitimate technical content (a devtools company answering a CLI question) apart from a leaked-prompt or RCE attempt | ✅ in place | `src/pipeline/moderate.ts` `buildSystemPrompt()` |
| Dangerous-shell-command rule is specific (remote-exec pipes, destructive commands, credential exfiltration) rather than a blanket ban on "code or shell commands" | ✅ in place | same |
| **MISSING:** unsubscribe footer on outbound (CAN-SPAM compliance for any marketing-adjacent reply) | ❌ P1 | — |
| **MISSING:** brand-voice consistency check (does the reply sound on-brand?) | ❌ P2 | — |
| **MISSING:** hallucination scorer (does the reply contain claims not present in retrieved chunks?) | ❌ P2 | — |

**Risk-now (post-fix):** the moderation step uses the same LLM family as generation, so it can miss the same blind spots. PII leakage is detected when the reply text contains identifiable patterns (emails, phone numbers, IDs); but a moderation pass cannot stop a reply that subtly leaks something contextual. For high-stakes tenants (legal / medical / financial), `autoSend=false` (draft mode) is the right configuration until quality is proven.

**Calibration history:** an earlier blanket rule "no code or shell commands" caused false-positives for devtools tenants whose customers were legitimately asking about CLI usage. The fix (2026-05-22) was twofold: (a) feed the moderator the tenant's company description so it has business context, and (b) carve out an explicit "technical content is fine if it answers the customer's question and matches the business" allowance, with the dangerous-pattern rule scoped down to actual remote-exec / destructive / credential-exfiltration shapes. Two integration tests now lock both directions in: `OK — devtools company answering a legitimate CLI question` and `FLAGGED — dangerous shell command (curl pipe to bash)`. Don't reintroduce the blanket rule.

---

## 5. Authentication & access control

| Control | Status | Where |
|---|---|---|
| Google OAuth for admin sign-in (only auth path; no password fallback) | ✅ in place | `src/routes/oauth.ts` |
| OAuth state nonce — 16-byte signed nonce in 10-minute httpOnly cookie, verified on callback | ✅ in place | `src/routes/oauth.ts` `setStateCookie` / `consumeStateCookie` |
| Tenant auto-provisioned per email | ✅ in place | `src/routes/oauth.ts` |
| HMAC-signed session cookie | ✅ in place | `src/lib/auth.ts` |
| Cookie httpOnly + sameSite=lax + secure in prod | ✅ in place | same |
| Cookie expiry enforcement — 7-day server-side max-age check on top of browser maxAge (refuses leaked-but-unrotated cookies) | ✅ in place | `src/lib/auth.ts` `parseSession` |
| Session cookie carries `(email, tenant_id)` validated per-request against `memberships` table | ✅ in place | `src/lib/auth.ts` `requireAdmin` |
| Per-IP signin rate limit (5/hour) | ✅ in place | `src/routes/oauth.ts` |
| CSRF double-submit token on every state-changing route | ✅ in place | `src/lib/auth.ts` `csrfGuard` |
| POST-only logout endpoint with CSRF (prevents image-tag forced sign-out) | ✅ in place | `src/routes/admin.ts` |
| **MISSING:** session revocation on membership change (currently capped by 30-second in-process tenant cache, so revoke takes up to 30s to land) | ❌ P1 | — |
| **MISSING:** multi-admin invite flow (only 1 admin per tenant currently) | ❌ P2 | — |
| **MISSING:** "active sessions" view + force-logout | ❌ P2 | — |

---

## 6. Data isolation

| Control | Status | Where |
|---|---|---|
| Every per-tenant query filtered by `tenant_id` | ✅ in place | throughout codebase |
| `tenantScoped(db, id)` helper for safe queries | ✅ in place | `src/tenant/scoped.ts` |
| RLS enabled on every per-tenant table | ✅ in place | `supabase/migrations/002_multi_tenant.sql` |
| Vector search RPC requires tenant_id parameter | ✅ in place | `match_kb_chunks` |
| Tenant-isolation integration test | ✅ in place | `tests/integration/tenant-isolation.test.ts` |
| **MISSING:** code-review checklist enforcing scoped queries (we caught at-time-of-review, no automated guard) | ❌ P1 | — |
| **MISSING:** RLS policies with actual tenant_id JWT enforcement (currently RLS is "enabled but no policies" = denies anon access, which is correct but leaves us reliant on app-code scoping) | ❌ P2 | — |

**Risk if missed:** a future code change introduces an unscoped query and leaks tenant A's data to tenant B. RLS catches the worst cases (anon-key access) but app-code paths are not protected by RLS when service role is used.

**Recommended P1 fix:** add ESLint rule or a custom checker that flags any `.from('kb_documents')` / `.from('kb_chunks')` / `.from('messages')` / `.from('oauth_tokens')` call that isn't followed by `.eq('tenant_id', ...)` within 5 lines. Or migrate all such queries to go exclusively through `tenantScoped()`.

---

## 7. Secrets & token management

| Control | Status | Where |
|---|---|---|
| OAuth refresh tokens stored in DB | ✅ in place | `oauth_tokens` table |
| Service role key only used server-side | ✅ in place | `src/db/client.ts` |
| `.env.local` and `.env.production` gitignored | ✅ in place | `.gitignore` |
| OpenRouter API key not logged | ✅ in place | only sent in Authorization header |
| Tokens auto-refreshed on Google's `tokens` event | ✅ in place | `src/providers/gmail.ts` |
| Refresh + access tokens encrypted at rest with AES-256-GCM (`v1:` versioned format, random 12-byte IV per encrypt, 16-byte auth tag) | ✅ in place | `src/lib/crypto.ts` + `src/providers/gmail.ts` |
| Opportunistic re-encryption of legacy plaintext rows on read (covers the case where Google doesn't issue a fresh refresh_token on rotation) | ✅ in place | `src/providers/gmail.ts` `loadStoredTokensForTenant` |
| Encryption key separate from session HMAC (`TOKEN_ENCRYPTION_KEY` vs `SESSION_SECRET`) | ✅ in place | `src/config.ts` |
| **MISSING:** secret rotation runbook | ❌ P1 | docs |
| **MISSING:** alerting on refresh-token failures (silent failures today) | ❌ P1 | — |

**Risk-now (post-fix):** if the `TOKEN_ENCRYPTION_KEY` leaks alongside the Supabase service role key, encryption at rest is bypassed — defense-in-depth, not silver-bullet. Both keys must be rotated together if compromised. Rotating `TOKEN_ENCRYPTION_KEY` invalidates all stored tokens; tenants must reconnect Gmail.

---

## 8. Audit & observability

| Control | Status | Where |
|---|---|---|
| `audit_log` table with typed actions | ✅ in place | `src/tenant/audit.ts` |
| OAuth events, settings changes, KB ops, signins all audited | ✅ in place | distributed |
| `messages` table records every email decision | ✅ in place | `src/pipeline/run.ts` |
| `llm_usage` table records every model call with tokens + cost | ✅ in place | `src/tenant/usage.ts` |
| Structured logs via Pino | ✅ in place | `src/lib/logger.js` |
| **MISSING:** PII redaction in logs (we log email addresses, subject lines, body excerpts) | ❌ P1 | — |
| **MISSING:** centralised log aggregation (currently per-pm2-instance logs) | ❌ P2 | — |
| **MISSING:** anomaly alerting (volume spike, error spike, cost spike) | ❌ P2 | — |
| **MISSING:** audit log retention policy (currently keeps forever) | ❌ P1 | — |

**Risk if missed:** log files end up containing customer email body text and subjects. Anyone with shell access to the VPS can read them. Aggregator services (Datadog, Logtail) would see them too if used.

**Recommended P1:** in `src/lib/logger.ts`, add a serialiser that scrubs `body_text` fields and partial-masks email addresses (`ay***@a***corp.com`). Set a 90-day retention on `audit_log` and `messages.body_text` (keep the row, blank the body) via daily cron.

---

## 8b. Web-app hardening (added 2026-05-22)

| Control | Status | Where |
|---|---|---|
| CSP (`default-src 'self'`, strict frame-ancestors none, font allowlist for Google Fonts) | ✅ in place | `src/server.ts` |
| X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy | ✅ in place | same |
| HSTS in production | ✅ in place | same |
| CSRF double-submit on every POST/PUT/DELETE under /admin | ✅ in place | `src/lib/auth.ts` `csrfGuard` |
| Output XSS escaping on user-controlled fields (workspace name in onboarding summary) | ✅ in place | `src/ui/onboarding.html` |
| Zod schema validation on settings PUT with `.strict()` (rejects unknown keys; prevents JSONB-smuggle) | ✅ in place | `src/routes/settings.ts` |
| Body-parser hardening — 256kb JSON cap; `entity.too.large` mapped to friendly envelope | ✅ in place | `src/server.ts` |
| Consistent error envelope `{ error, message }` — no stack traces leak | ✅ in place | `src/lib/errors.ts` |
| Header-injection sanitization on outbound mail (`To`, `Subject`, `In-Reply-To`) | ✅ in place | `src/providers/gmail.ts` |
| **MISSING:** CSP without `unsafe-inline` (admin UI uses inline `<style>` / `<script>`; would need nonces or external files) | ❌ P2 | — |
| **MISSING:** Subresource Integrity on Google Fonts (CDN compromise risk) | ❌ P2 — explicitly deferred | — |

**Risk-now (post-fix):** the `unsafe-inline` on script/style means a successful XSS could still execute — but the escaping at every user-controlled-string boundary (G.10 in features) plus the strict schema validation (G.11) make injection unlikely in the first place.

---

## 9. Compliance (GDPR / CCPA / HIPAA / SOC2)

| Control | Status |
|---|---|
| Soft-delete with 30-day grace before hard delete | ✅ in place |
| Data export endpoint ("download my data") | ❌ MISSING (P1 for GDPR) |
| "Right to be forgotten" hard-delete on demand (bypass 30-day grace) | ❌ MISSING (P1 for GDPR) |
| Data Processing Agreement template | ❌ MISSING (P0 if any EU customer) |
| HIPAA Business Associate Agreement template | ❌ MISSING (P0 for healthcare tenants) |
| SOC 2 Type II report | ❌ MISSING (P0 for enterprise sales) |
| Data residency controls (region pinning) | ❌ MISSING (P0 for EU enterprise) |
| Privacy policy URL on the marketing site | ❌ MISSING (P0 for Google OAuth verification) |
| Terms of Service URL on the marketing site | ❌ MISSING (P0 for Google OAuth verification) |

**Risk if missed:** can't sell into regulated industries. Google OAuth verification can't be completed without privacy + ToS.

**Immediate action items:**
1. Publish a privacy policy at `example.com/privacy` (any reasonable boilerplate gets you started; have a lawyer review before signing first regulated customer).
2. Publish ToS at `example.com/terms`.
3. Submit OAuth app for Google verification.

---

## 10. Reply quality & user experience

| Control | Status |
|---|---|
| Confidence gate (don't reply with weak KB match) | ✅ in place |
| Reply length cap | ✅ in place |
| Threading: bot reply lands in same Gmail thread | ✅ in place |
| Owner-took-over detection (bot stops if you reply manually) | ✅ in place |
| Auto-send toggle (per tenant) — draft mode available | ✅ in place |
| Audit log shows reply text per message | ✅ in place |
| RFC 5322 Message-ID threading for non-Gmail recipients | ✅ in place |
| **MISSING:** owner pre-approval queue for the first N replies of a new tenant ("training wheels") | ❌ P1 | — |
| **MISSING:** "thumbs up / down" feedback loop from owner on each reply | ❌ P1 | — |
| **MISSING:** reply preview in real-time as it streams (currently waits for full reply) | ❌ P2 | — |
| **MISSING:** A/B testing of two reply models / tones for the same email | ❌ P2 | — |

**Recommended P1 fix:** for the first 10 replies after a tenant goes live, route to draft mode regardless of the `autoSend` setting. Surface in the dashboard as "Reply queued — review and send → train the model". After 10 reviewed and approved, switch to auto-send.

---

## 11. Operational kill-switches

| Control | Status |
|---|---|
| Tenant can flip `autoSend` to false (drafts only) in Settings | ✅ in place |
| Tenant can disconnect Gmail (revoke at myaccount.google.com) | ✅ in place (operator action) |
| Tenant can soft-delete entire workspace | ✅ in place |
| One-click "Pause bot" / "Resume bot" toggle in sidebar footer + persistent banner | ✅ in place (`src/ui/admin.html`) |
| Graceful SIGTERM drain (15s) so `pm2 reload` doesn't leave half-processed messages | ✅ in place (`src/server.ts`) |
| **MISSING:** global kill-switch (deployment-wide pause of all tenants) | ❌ P1 | — |
| **MISSING:** scheduled pause ("no replies after 6pm Friday") | ❌ P2 | — |

---

## 12. Edge cases we have verified

These are concrete scenarios we have manual-tested or have automated coverage for:

- ✅ Sender sends a "Test" subject — classifier correctly returns OTHER, bot doesn't reply
- ✅ Sender sends a real question with KB-matching content — bot replies
- ✅ Sender sends a real question with NO KB match — bot logs `no-kb-match`, doesn't reply
- ✅ Owner manually replies in thread — subsequent bot polls skip thread
- ✅ Newsletter with `List-Unsubscribe` header arrives — skipped as `skipped_loop`
- ✅ Bot's own reply arrives in inbox somehow — skipped as `skipped_self`
- ✅ Empty PDF uploaded — fails with "PDF contains no extractable text"
- ✅ Oversized PDF uploaded (>25MB) — rejected client-side and server-side
- ✅ Same email polled twice (Gmail retry) — idempotency check prevents double-reply
- ✅ KB chunker hit infinite-loop bug — fixed and unit-tested (see chunk.test.ts)
- ✅ Session expired — fetch sees 401 and redirects to login
- ✅ Cross-tenant data leak attempt — integration test verifies isolation
- ✅ Inbound prompt-injection email — risk classifier flags as UNSAFE; live LLM integration test in `tests/integration/safety-guards.test.ts`
- ✅ Inbound legal threat / fraud / phishing — same risk-classifier test suite
- ✅ Outbound reply with profanity / unauthorised legal commitment / PII leakage / leaked system prompt — moderation flags before send; same suite
- ✅ Inbound email from `mailer-daemon` / `noreply` / `postmaster` — system-sender deny list skips
- ✅ Per-sender daily reply cap — tested via `assertPerSenderReplyQuota`
- ✅ Daily LLM spend cap exceeded — pipeline writes `error / failed` row with cap message, no further LLM calls until next UTC day
- ✅ Header-injection attempt via crafted `Subject` / `From` / `Message-ID` — `sanitizeHeader` / `sanitizeMessageId` strip CRLF; 13-case unit suite in `tests/unit/header-injection.test.ts`
- ✅ Tampered OAuth token ciphertext — AES-GCM auth-tag check rejects on read; covered in `tests/unit/crypto.test.ts`
- ✅ Legacy plaintext OAuth row — opportunistically re-encrypted on next read
- ✅ Forged OAuth callback (attacker-supplied `state`) — state-nonce cookie check rejects
- ✅ CSRF attempt on state-changing route — `csrfGuard` returns 403 with friendly message
- ✅ pm2 reload mid-poll — SIGTERM handler drains for 15s before exit

## 13. Edge cases we have NOT verified

- ❌ Inbound email with massive body (>200KB) — currently truncated to 50KB on store and capped at 1000 chars for embedding, but behaviour with truncated context unproven
- ❌ Inbound email with attachments — currently silently ignored, should be explicitly flagged
- ❌ Outbound reply that's flagged as spam by recipient's server — no feedback loop
- ❌ Same tenant uploads 1000 PDFs rapidly — chunk cap should hit but per-hour upload rate limit not
- ❌ Two admins on the same tenant editing settings simultaneously — last-write-wins (no concurrency control)
- ❌ Bot keeps generating replies while OpenRouter is rate-limiting us — we error per reply but don't back off
- ❌ 100+ concurrent tenants on one poll tick — `POLL_CONCURRENCY=10` should keep us inside limits but not load-tested

---

## Priority summary

### ✅ P0 — shipped 2026-05-21 / 2026-05-22

1. ~~Per-sender daily reply cap~~ — shipped (`src/tenant/limits.ts`)
2. ~~`mailer-daemon` / `noreply` / `postmaster` deny list~~ — shipped (`src/pipeline/loop-guard.ts` `isSystemSender`)
3. ~~Inbound risk classifier~~ — shipped (`src/pipeline/risk.ts`), now runs in parallel with the customer-query classifier
4. ~~Outbound moderation check~~ — shipped (`src/pipeline/moderate.ts`)
5. ~~One-click "Pause bot" toggle~~ — shipped (sidebar + banner)
6. ~~Per-tenant daily LLM spend cap~~ — shipped (`assertDailySpendCap`)
7. ~~Per-IP signup rate limit~~ — shipped (`signinLimiter` on `/oauth/signin`)
8. ~~Refresh token encryption at rest~~ — shipped (AES-256-GCM via `src/lib/crypto.ts`), promoted from P1 after the security review
9. ~~Cookie-expiry server-side validation~~ — shipped (7-day max-age check in `src/lib/auth.ts`)
10. ~~CSRF protection~~ — shipped (double-submit token, `csrfGuard`)
11. ~~CSP + security headers~~ — shipped (`src/server.ts`)
12. ~~OAuth state nonce~~ — shipped (forged-callback defense, `src/routes/oauth.ts`)
13. ~~Header-injection sanitization on outbound mail~~ — shipped (`sanitizeHeader`, `sanitizeMessageId`)
14. ~~Stored XSS in onboarding summary~~ — shipped (escape `tenant.name`)
15. ~~KB-context-as-untrusted in reply system prompt~~ — shipped (`src/pipeline/generate.ts`)
16. ~~Zod schema validation on settings PUT~~ — shipped
17. ~~Error envelope (`{ error, message }`)~~ — shipped (`src/lib/errors.ts`)
18. ~~Graceful SIGTERM shutdown~~ — shipped (15s drain, `src/server.ts`)
19. **NOT-ENGINEERING:** Privacy policy + ToS pages — still blocking Google OAuth verification

### P1 — remaining

20. **Log PII redaction** (mask email addresses + body excerpts in pino logs) — ~2 hours
21. **Session revocation on membership change** (currently capped by 30s tenant cache) — ~2 hours
22. **"Training wheels" first 10 replies in draft mode** — ~3 hours
23. **Data export endpoint** (GDPR) — ~3 hours
24. **Hard-delete-on-demand endpoint** (GDPR right to be forgotten) — ~2 hours
25. **Audit log retention policy + 90-day body-text wipe cron** — ~2 hours
26. **Alerting on refresh-token failures** — ~2 hours
27. **Secret rotation runbook** — docs only

**Total: ~16 hours of engineering + docs.**

### P2 — when scale demands it

28. Multi-admin invites per tenant
29. Per-thread reply cap (in addition to per-sender)
30. Reply quality scorer + feedback loop
31. Anomaly alerting (volume / error / cost spikes)
32. RLS policies with JWT enforcement (defense beyond service role)
33. Centralised log aggregation
34. Active-sessions view + force-logout
35. CSP without `unsafe-inline` (nonce-based or external scripts/styles)

---

## How to use this document

Before any client demo: skim section 12 (verified edge cases) — these are the things you can confidently say work.

Before any paying client onboards: section 13 (unverified edge cases) is the answer to "what could go wrong?" Pick the P0s that apply to that client's industry and ship them.

Before any enterprise sale: section 9 (compliance) lists the actual gating items. Most won't apply to SMB customers; all apply to anyone with a regulated industry.

This document is living. Update after every incident. Re-run the audit before every major launch.
