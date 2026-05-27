# hiagents · Feature inventory

The canonical list of what the product offers. Use this to see what's shipped, what's in flight, and what's been intentionally removed.

Each feature has a status:

- **✅ Shipped** — live in `main` today
- **🛠 In progress** — being built right now
- **🗺 Roadmap** — agreed direction, not yet started
- **❓ Considering** — open question, may not happen
- **🚫 Removed** — was shipped, intentionally removed. Date + reason recorded inline so it doesn't get re-discussed.

Update this file whenever a feature ships or its status changes.

Last updated: 2026-05-22

---

## A. Core email automation

| # | Feature | Status |
|---|---|---|
| A.1 | Connect a Gmail mailbox via Google OAuth (no password sharing) | ✅ Shipped |
| A.2 | Poll inbox every 60s for new mail | ✅ Shipped |
| A.3 | Classify each email as a customer query vs noise (newsletters, automated mail) | ✅ Shipped |
| A.4 | Retrieve relevant passages from your knowledge base via semantic search | ✅ Shipped |
| A.5 | Generate a reply grounded only in retrieved knowledge — no fabrication | ✅ Shipped |
| A.6 | Send reply in-thread via Gmail API, preserving Message-ID for cross-client threading (header values sanitized to block CRLF injection from attacker-controlled inbound mail) | ✅ Shipped |
| A.7 | Label processed emails in Gmail (hiagents/replied, hiagents/skipped, hiagents/failed) | 🚫 Removed 2026-05-22 — same status info is on each `messages` row + visible in the Activity dashboard; writing labels into the user's mailbox was visual clutter for very little marginal value |
| A.7a | Mark processed emails as read in Gmail | 🚫 Removed 2026-05-22 — silently changing the user's unread count was worse than the labels (the unread count is the primary signal users use to manage their inbox). Dedupe is handled by the `messages.gmail_message_id` idempotency check in `runPipeline` instead |
| A.8 | Per-email audit log (decision, retrieved chunks, similarity score, reply text, status) | ✅ Shipped |
| A.9 | Auto-send vs draft mode toggle (per tenant) | ✅ Shipped |
| A.10 | First-N-replies-as-drafts "training wheels" mode | 🗺 Roadmap |
| A.11 | Multi-language reply support (bot replies in sender's language) | 🗺 Roadmap |
| A.12 | Per-thread reply cap (max bot replies in one Gmail thread) | 🗺 Roadmap |
| A.13 | Gmail Pub/Sub push notifications (instant reply, no 60s poll wait) | 🗺 Roadmap |

## B. Knowledge base

| # | Feature | Status |
|---|---|---|
| B.1 | Upload PDFs via drag-and-drop | ✅ Shipped |
| B.2 | Automatic text extraction, chunking, embedding (OpenAI text-embedding-3-small) | ✅ Shipped |
| B.3 | Per-tenant pgvector store, isolated by tenant_id | ✅ Shipped |
| B.4 | Hybrid retrieval (similarity threshold + top-K, both configurable) | ✅ Shipped |
| B.5 | Confidence gate: skip reply if no chunks above threshold | ✅ Shipped |
| B.6 | Delete document (cascades to chunks) | ✅ Shipped |
| B.7 | PDF size cap (configurable, default 25MB) | ✅ Shipped |
| B.8 | Total chunk cap per tenant (configurable, default 5,000) | ✅ Shipped |
| B.9 | DOCX / TXT / HTML ingestion (currently PDF-only) | 🗺 Roadmap |
| B.10 | Google Drive / Notion / Confluence connector for live sync | 🗺 Roadmap |
| B.11 | URL ingestion ("crawl my docs site") | 🗺 Roadmap |
| B.12 | Image-aware retrieval (OCR + vision embeddings for diagrams in PDFs) | 🗺 Roadmap |
| B.13 | KB versioning + rollback ("revert to last week's docs") | ❓ Considering |

## C. Persona & voice

| # | Feature | Status |
|---|---|---|
| C.1 | Tone selector (Professional / Friendly / Formal / Playful + custom) | ✅ Shipped |
| C.2 | Signature configurable per tenant | ✅ Shipped |
| C.3 | Company / context description — interpolated into the reply system prompt as "you are replying on behalf of …" so the bot knows who it represents. Optional; empty falls back to generic framing | ✅ Shipped |
| C.4 | Custom classifier prompt (decide what counts as a customer query) | ✅ Shipped |
| C.5 | Per-tenant choice of reply model | 🚫 Removed 2026-05-22 — model is deployment-wide, edit `defaultTenantSettings()` to change |
| C.6 | Per-tenant choice of classifier model | 🚫 Removed 2026-05-22 — same reason as C.5 |
| C.7 | Brand voice training from past replies ("learn how I write") | 🗺 Roadmap |
| C.8 | Per-recipient tone adaptation (formal for executives, casual for known contacts) | 🗺 Roadmap |
| C.9 | Multi-signature support (different signature per topic) | ❓ Considering |

## D. Safety & guardrails

| # | Feature | Status |
|---|---|---|
| D.1 | Loop protection: detect Auto-Submitted, X-Autoreply, Precedence, List-Unsubscribe headers | ✅ Shipped |
| D.2 | Set Auto-Submitted: auto-replied on our outgoing mail so other bots don't loop with us | ✅ Shipped |
| D.3 | Thread guard: stop replying in a thread when the owner has manually responded | ✅ Shipped |
| D.4 | Self-guard: never reply to mail from the connected mailbox itself | ✅ Shipped |
| D.5 | System-sender deny list (mailer-daemon, no-reply, postmaster, abuse, bounces) | ✅ Shipped |
| D.6 | Per-sender daily reply cap (default 5/sender/day, configurable) | ✅ Shipped |
| D.7 | Per-tenant daily email cap (default 200/day, configurable) | ✅ Shipped |
| D.8 | Inbound risk classifier — refuses to reply to threats, legal language, prompt injection, abuse, fraud patterns | ✅ Shipped |
| D.9 | Outbound moderation — blocks toxic, legally-risky, or PII-leaking replies before send | ✅ Shipped |
| D.10 | Per-tenant daily LLM spend cap (default $5, configurable) | ✅ Shipped |
| D.11 | One-click pause-bot kill switch (sidebar button + persistent banner) | ✅ Shipped |
| D.12 | Per-IP signup rate limit (5/hour) | ✅ Shipped |
| D.13 | KB-context-as-untrusted in reply-generation system prompt (the model is told to never follow instructions embedded in KB chunks or the inbound email — defends against prompt injection that survived the inbound risk gate) | ✅ Shipped |
| D.14 | Outbound header sanitization (strip CRLF / NUL from `To` / `Subject` / `In-Reply-To` so a malicious inbound email can't inject extra headers like Bcc into the auto-reply) | ✅ Shipped |
| D.15 | Per-recipient blocklist ("never reply to this domain") | 🗺 Roadmap |
| D.16 | Custom safety rules ("flag any reply mentioning competitor X") | 🗺 Roadmap |
| D.17 | Owner pre-approval queue for first N replies of a new workspace | 🗺 Roadmap |

## E. Activity & observability

| # | Feature | Status |
|---|---|---|
| E.1 | Recent activity table — last 100 emails with classification + reply status | ✅ Shipped |
| E.2 | Click any row to expand the actual reply text the bot sent | ✅ Shipped |
| E.3 | Filter activity by All / Sent / Skipped / Failed | ✅ Shipped |
| E.4 | Per-message audit detail: retrieved chunk IDs, top similarity score, reply timestamp | ✅ Shipped |
| E.5 | KPI dashboard: documents, replies sent 7d, skipped 7d, last email timestamp | ✅ Shipped |
| E.6 | AI usage summary in Settings — total USD cost over the last 30 days (the previous per-model token table was simplified to a single big-number total; per-model breakdown is still queryable in `llm_usage` for operators) | ✅ Shipped |
| E.7 | Audit log for all admin actions (settings changes, KB ops, OAuth events) | ✅ Shipped |
| E.8 | Real-time activity stream (WebSocket / SSE) | 🗺 Roadmap |
| E.9 | Email-summary digest ("yesterday: 47 replies sent, 3 flagged") | 🗺 Roadmap |
| E.10 | Slack / Teams integration for daily summary + flagged-reply alerts | 🗺 Roadmap |
| E.11 | Webhook on every event (reply sent / skipped / failed) | 🗺 Roadmap |
| E.12 | Custom-event export (CSV, JSON, BI tool) | 🗺 Roadmap |
| E.13 | Anomaly alerting (volume spike, error spike, cost spike) | 🗺 Roadmap |

## F. Workspace & team

| # | Feature | Status |
|---|---|---|
| F.1 | Auto-provisioned workspace on first Google sign-in | ✅ Shipped |
| F.2 | One owner per workspace (the email that signed up) | ✅ Shipped |
| F.3 | Three-step onboarding wizard (Set up workspace / Knowledge / Review) — Gmail is granted at sign-in via the unified OAuth flow, so there's no separate Connect-Gmail step. Workspace name, persona, and classifier prompt are combined into one Set-up card. | ✅ Shipped |
| F.3a | Unified Google OAuth — sign-in requests identity + Gmail scopes in one consent screen, so the very first OAuth dance also connects the mailbox. Saves one click + collapses the duplicate "Account" / "Gmail mailbox" cards in Settings into one "Connected account" card. | ✅ Shipped |
| F.3b | "Use a different Gmail" escape hatch in Settings — keeps the rare power-user case of "admin signs in as A, bot polls B" working without forcing it on everyone. | ✅ Shipped |
| F.4 | "Start over with a different account" during onboarding | ✅ Shipped |
| F.5 | Soft-delete workspace (30-day grace before hard delete) | ✅ Shipped |
| F.6 | Invite teammates as additional admins / viewers | 🗺 Roadmap |
| F.7 | Role-based access control (owner / admin / viewer / read-only) | 🗺 Roadmap |
| F.8 | Tenant-switcher for users in multiple workspaces | 🗺 Roadmap |
| F.9 | Active sessions view + force-logout | 🗺 Roadmap |
| F.10 | SSO via SAML / OIDC (Okta / Google Workspace) | 🗺 Roadmap |
| F.11 | SCIM provisioning | 🗺 Roadmap |

## G. Security & compliance

| # | Feature | Status |
|---|---|---|
| G.1 | HMAC-signed session cookies (httpOnly, sameSite=lax, secure in prod) with server-side 7-day max-age check (a leaked-but-unrotated cookie is refused even if HMAC valid) | ✅ Shipped |
| G.2 | Row-Level Security enabled on every per-tenant table | ✅ Shipped |
| G.3 | Per-query tenant scoping via tenantScoped() helper | ✅ Shipped |
| G.4 | Tenant isolation integration test (verifies no cross-tenant leakage) | ✅ Shipped |
| G.5 | Per-IP signin rate limit (5/hour) on `/oauth/signin` | ✅ Shipped |
| G.6 | OAuth refresh + access tokens encrypted at rest with AES-256-GCM (random IV per encrypt, GCM auth tag, `v1:` versioned format). Legacy plaintext rows opportunistically re-encrypted on next read. | ✅ Shipped |
| G.7 | CSRF protection: double-submit token pattern (HMAC-signed `hiagents_csrf` cookie + `X-CSRF-Token` header) enforced on every state-changing route | ✅ Shipped |
| G.8 | Content Security Policy + X-Content-Type-Options + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy on every response; HSTS in production | ✅ Shipped |
| G.9 | OAuth state nonce — every `/oauth/signin` and `/oauth/start` mints a 16-byte signed nonce in a 10-minute httpOnly cookie; `/oauth/callback` rejects on mismatch (defends against forged-callback phishing) | ✅ Shipped |
| G.10 | Output-side XSS escaping on user-controlled fields (workspace name) before innerHTML injection | ✅ Shipped |
| G.11 | Zod schema validation on every settings PUT with `.strict()` (rejects unknown keys, prevents JSONB-smuggle attacks like `superAdmin: true`) | ✅ Shipped |
| G.12 | Consistent error envelope (`{ error: machine-code, message: user-friendly }`) — no stack traces or internal IDs leak to the client; server-side logging of full context | ✅ Shipped |
| G.13 | Audit log of every auth event (signin, signout, gmail.connected, tenant.provisioned) with IP recorded | ✅ Shipped |
| G.14 | Body-parser hardening — 256kb JSON cap (multer keeps its 25MB cap for PDF uploads), `entity.too.large` and JSON parse errors mapped to friendly envelope | ✅ Shipped |
| G.15 | Log PII redaction (mask email addresses + body text in logs) | 🗺 Roadmap |
| G.16 | Session revocation on membership change (currently capped by 30s tenant cache) | 🗺 Roadmap |
| G.17 | Data export endpoint ("download my data" for GDPR) | 🗺 Roadmap |
| G.18 | Hard-delete-on-demand (GDPR right to be forgotten, bypass 30-day grace) | 🗺 Roadmap |
| G.19 | Audit log retention policy (90-day body-text wipe) | 🗺 Roadmap |
| G.20 | SOC 2 Type II certification | 🗺 Roadmap |
| G.21 | HIPAA-ready (BAA available) | 🗺 Roadmap |
| G.22 | GDPR / Data Processing Agreement | 🗺 Roadmap |
| G.23 | Data residency controls (EU / US / APAC region pinning) | 🗺 Roadmap |
| G.24 | Customer-managed encryption keys (BYOK) | ❓ Considering |
| G.25 | 2FA on admin sign-in | ❓ Considering — Google sign-in is the only auth path, so 2FA is delegated to the user's Google account |

## H. Configuration & operator controls

| # | Feature | Status |
|---|---|---|
| H.1 | Per-tenant settings UI: persona, classifier prompt, auto-send, pause toggle, danger-zone delete | ✅ Shipped |
| H.2 | Operator-controlled reply + classifier model (no tenant dropdown; edit `defaultTenantSettings()` to change) | ✅ Shipped |
| H.3 | Configurable similarity threshold + top-K | 🚫 Removed 2026-05-22 from per-tenant UI — these are operator-tuning knobs, not user-facing decisions. Defaults work for everyone; an operator can still edit `defaultTenantSettings()` or hit the settings PUT endpoint directly (the Zod schema still accepts them) |
| H.4 | Per-tenant rate-limit knobs (daily email cap, per-sender cap, spend cap) | ✅ Shipped |
| H.5 | Bring-your-own OpenRouter key (per-tenant cost attribution) | 🗺 Roadmap |
| H.6 | Bring-your-own OpenAI / Anthropic / Google key | 🗺 Roadmap |
| H.7 | Custom moderation rules (deny list of phrases bot should never use) | 🗺 Roadmap |
| H.8 | Webhook to override classifier verdict ("send all questions about X to me first") | 🗺 Roadmap |
| H.9 | Scheduled pause ("no replies after 6pm Friday") | 🗺 Roadmap |
| H.10 | A/B testing of two reply models / tones | ❓ Considering |

## I. Reporting & analytics

| # | Feature | Status |
|---|---|---|
| I.1 | Per-model token + cost rollup (last 30 days) | ✅ Shipped |
| I.2 | Activity counts (sent / skipped / failed, last 7 days) | ✅ Shipped |
| I.3 | Weekly email digest of activity | 🗺 Roadmap |
| I.4 | Monthly usage breakdown | 🗺 Roadmap |
| I.5 | Reply quality scorer (model-graded "would a human have replied this way?") | 🗺 Roadmap |
| I.6 | Customer satisfaction tracking (CSAT signal from inbound follow-up sentiment) | 🗺 Roadmap |
| I.7 | Cohort analysis ("how is reply quality trending by topic?") | 🗺 Roadmap |
| I.8 | Custom dashboards / BI export | 🗺 Roadmap |

## J. Integrations

| # | Feature | Status |
|---|---|---|
| J.1 | Gmail / Google Workspace | ✅ Shipped |
| J.2 | Outlook / Microsoft 365 | 🗺 Roadmap |
| J.3 | Slack notifications | 🗺 Roadmap |
| J.4 | Zapier / Make webhook compatibility | 🗺 Roadmap |
| J.5 | Salesforce / HubSpot CRM sync (write reply log back to contact record) | 🗺 Roadmap |
| J.6 | Zendesk / Front / Help Scout (route flagged replies into your support tool) | 🗺 Roadmap |
| J.7 | Generic webhook API | 🗺 Roadmap |
| J.8 | REST API for programmatic KB + reply management | 🗺 Roadmap |

## K. Deployment & ops

| # | Feature | Status |
|---|---|---|
| K.1 | Multi-tenant single deployment (auto-provisioned workspace per email) | ✅ Shipped |
| K.2 | Health endpoint for uptime monitoring | ✅ Shipped |
| K.3 | PM2 + nginx self-hosted (Docker compose available) | ✅ Shipped |
| K.3a | Graceful SIGTERM/SIGINT shutdown (15s drain) — pm2 reloads don't cut in-flight requests or leave half-processed messages | ✅ Shipped |
| K.3b | Concurrent poller (cap 10 tenants per tick) with explicit undici socket pool (`SUPABASE_MAX_SOCKETS`, default 32) so a 100-tenant deployment runs in ~2s per tick without thundering-herd against Gmail / OpenRouter / Supabase | ✅ Shipped |
| K.3c | In-process tenant lookup cache (30s TTL with invalidate-on-write) — cuts ~80% of `memberships JOIN tenants` round-trips on active admin use | ✅ Shipped |
| K.3d | Gmail label-id cache per tenant (eliminates a `labels.list` API call per processed message) | ✅ Shipped |
| K.4 | Self-hosted "single tenant" option (your VPS, your Supabase) | 🗺 Roadmap |
| K.5 | On-prem / VPC deployment | ❓ Considering |

---

## How to use this doc

**When considering a new feature:** add it as ❓ with a one-line use case. Promote to 🗺 if direction is agreed; otherwise leave or remove.

**When a feature ships:** flip its status to ✅, push an update to this file in the same PR as the shipping code.

**Quarterly review:** any feature at 🗺 for over six months gets a hard look. Either promote to 🛠 or downgrade to ❓ or remove. Roadmaps that don't move are noise.

**When a feature gets removed:** flip to 🚫 with the date and the reason. Don't delete the row — the reason is the most useful part for the next contributor who's about to re-add it.
