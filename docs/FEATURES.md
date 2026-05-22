# hiagents · Feature inventory

The canonical list of what the product offers end users. **Source of truth** for the pricing page, sales conversations, and the marketing site.

Each feature has a status:

- **✅ Shipped** — live and in use today
- **🛠 In progress** — being built right now
- **🗺 Roadmap** — agreed direction, not yet started
- **❓ Considering** — open question, may not happen
- **🚫 Removed** — was shipped, intentionally removed. Date + reason recorded inline so it doesn't get re-discussed.

Each feature also lists its tier eligibility:

- **All tiers** — included in every plan
- **Pro+** — Pro and Enterprise
- **Enterprise** — Enterprise only

Update this file whenever a feature ships or its status changes. Then update the pricing page from this file (don't hand-edit the pricing page).

Last updated: 2026-05-22

---

## A. Core email automation

| # | Feature | Status | Tier |
|---|---|---|---|
| A.1 | Connect a Gmail mailbox via Google OAuth (no password sharing) | ✅ Shipped | All tiers |
| A.2 | Poll inbox every 60s for new mail | ✅ Shipped | All tiers |
| A.3 | Classify each email as a customer query vs noise (newsletters, automated mail) | ✅ Shipped | All tiers |
| A.4 | Retrieve relevant passages from your knowledge base via semantic search | ✅ Shipped | All tiers |
| A.5 | Generate a reply grounded only in retrieved knowledge — no fabrication | ✅ Shipped | All tiers |
| A.6 | Send reply in-thread via Gmail API, preserving Message-ID for cross-client threading (header values sanitized to block CRLF injection from attacker-controlled inbound mail) | ✅ Shipped | All tiers |
| A.7 | Label processed emails in Gmail (hiagents/replied, hiagents/skipped, hiagents/failed) | 🚫 Removed 2026-05-22 — same status info is on each `messages` row + visible in the Activity dashboard; writing labels into the user's mailbox was visual clutter for very little marginal value | — |
| A.8 | Per-email audit log (decision, retrieved chunks, similarity score, reply text, status) | ✅ Shipped | All tiers |
| A.9 | Auto-send vs draft mode toggle (per tenant) | ✅ Shipped | All tiers |
| A.10 | First-N-replies-as-drafts "training wheels" mode | 🗺 Roadmap | All tiers |
| A.11 | Multi-language reply support (bot replies in sender's language) | 🗺 Roadmap | Pro+ |
| A.12 | Per-thread reply cap (max bot replies in one Gmail thread) | 🗺 Roadmap | All tiers |
| A.13 | Gmail Pub/Sub push notifications (instant reply, no 60s poll wait) | 🗺 Roadmap | Pro+ |

## B. Knowledge base

| # | Feature | Status | Tier |
|---|---|---|---|
| B.1 | Upload PDFs via drag-and-drop | ✅ Shipped | All tiers |
| B.2 | Automatic text extraction, chunking, embedding (OpenAI text-embedding-3-small) | ✅ Shipped | All tiers |
| B.3 | Per-tenant pgvector store, isolated by tenant_id | ✅ Shipped | All tiers |
| B.4 | Hybrid retrieval (similarity threshold + top-K, both configurable) | ✅ Shipped | All tiers |
| B.5 | Confidence gate: skip reply if no chunks above threshold | ✅ Shipped | All tiers |
| B.6 | Delete document (cascades to chunks) | ✅ Shipped | All tiers |
| B.7 | PDF size cap (configurable, default 25MB) | ✅ Shipped | All tiers |
| B.8 | Total chunk cap per tenant (configurable, default 5,000) | ✅ Shipped | All tiers |
| B.9 | DOCX / TXT / HTML ingestion (currently PDF-only) | 🗺 Roadmap | All tiers |
| B.10 | Google Drive / Notion / Confluence connector for live sync | 🗺 Roadmap | Pro+ |
| B.11 | URL ingestion ("crawl my docs site") | 🗺 Roadmap | Pro+ |
| B.12 | Image-aware retrieval (OCR + vision embeddings for diagrams in PDFs) | 🗺 Roadmap | Pro+ |
| B.13 | KB versioning + rollback ("revert to last week's docs") | ❓ Considering | Enterprise |

## C. Persona & voice

| # | Feature | Status | Tier |
|---|---|---|---|
| C.1 | Tone selector (Professional / Friendly / Formal / Playful + custom) | ✅ Shipped | All tiers |
| C.2 | Signature configurable per tenant | ✅ Shipped | All tiers |
| C.3 | Company / context description (grounds replies in your business) | ✅ Shipped | All tiers |
| C.4 | Custom classifier prompt (decide what counts as a customer query) | ✅ Shipped | Pro+ |
| C.5 | Per-tenant choice of reply model | 🚫 Removed 2026-05-22 — model is deployment-wide, edit `defaultTenantSettings()` to change | — |
| C.6 | Per-tenant choice of classifier model | 🚫 Removed 2026-05-22 — same reason as C.5 | — |
| C.7 | Brand voice training from past replies ("learn how I write") | 🗺 Roadmap | Pro+ |
| C.8 | Per-recipient tone adaptation (formal for executives, casual for known contacts) | 🗺 Roadmap | Pro+ |
| C.9 | Multi-signature support (different signature per topic) | ❓ Considering | Pro+ |

## D. Safety & guardrails

| # | Feature | Status | Tier |
|---|---|---|---|
| D.1 | Loop protection: detect Auto-Submitted, X-Autoreply, Precedence, List-Unsubscribe headers | ✅ Shipped | All tiers |
| D.2 | Set Auto-Submitted: auto-replied on our outgoing mail so other bots don't loop with us | ✅ Shipped | All tiers |
| D.3 | Thread guard: stop replying in a thread when the owner has manually responded | ✅ Shipped | All tiers |
| D.4 | Self-guard: never reply to mail from the connected mailbox itself | ✅ Shipped | All tiers |
| D.5 | System-sender deny list (mailer-daemon, no-reply, postmaster, abuse, bounces) | ✅ Shipped | All tiers |
| D.6 | Per-sender daily reply cap (default 5/sender/day, configurable) | ✅ Shipped | All tiers |
| D.7 | Per-tenant daily email cap (default 200/day, configurable) | ✅ Shipped | All tiers |
| D.8 | Inbound risk classifier — refuses to reply to threats, legal language, prompt injection, abuse, fraud patterns | ✅ Shipped | All tiers |
| D.9 | Outbound moderation — blocks toxic, legally-risky, or PII-leaking replies before send | ✅ Shipped | All tiers |
| D.10 | Per-tenant daily LLM spend cap (default $5, configurable) | ✅ Shipped | All tiers |
| D.11 | One-click pause-bot kill switch (sidebar button + persistent banner) | ✅ Shipped | All tiers |
| D.12 | Per-IP signup rate limit (5/hour) | ✅ Shipped | All tiers |
| D.13 | KB-context-as-untrusted in reply-generation system prompt (the model is told to never follow instructions embedded in KB chunks or the inbound email — defends against prompt injection that survived the inbound risk gate) | ✅ Shipped | All tiers |
| D.14 | Outbound header sanitization (strip CRLF / NUL from `To` / `Subject` / `In-Reply-To` so a malicious inbound email can't inject extra headers like Bcc into the auto-reply) | ✅ Shipped | All tiers |
| D.15 | Per-recipient blocklist ("never reply to this domain") | 🗺 Roadmap | All tiers |
| D.16 | Custom safety rules ("flag any reply mentioning competitor X") | 🗺 Roadmap | Pro+ |
| D.17 | Owner pre-approval queue for first N replies of a new workspace | 🗺 Roadmap | All tiers |

## E. Activity & observability

| # | Feature | Status | Tier |
|---|---|---|---|
| E.1 | Recent activity table — last 100 emails with classification + reply status | ✅ Shipped | All tiers |
| E.2 | Click any row to expand the actual reply text the bot sent | ✅ Shipped | All tiers |
| E.3 | Filter activity by All / Sent / Skipped / Failed | ✅ Shipped | All tiers |
| E.4 | Per-message audit detail: retrieved chunk IDs, top similarity score, reply timestamp | ✅ Shipped | All tiers |
| E.5 | KPI dashboard: documents, replies sent 7d, skipped 7d, last email timestamp | ✅ Shipped | All tiers |
| E.6 | Per-model LLM usage rollup (tokens + USD cost, last 30 days) | ✅ Shipped | All tiers |
| E.7 | Audit log for all admin actions (settings changes, KB ops, OAuth events) | ✅ Shipped | All tiers |
| E.8 | Real-time activity stream (WebSocket / SSE) | 🗺 Roadmap | Pro+ |
| E.9 | Email-summary digest ("yesterday: 47 replies sent, 3 flagged") | 🗺 Roadmap | All tiers |
| E.10 | Slack / Teams integration for daily summary + flagged-reply alerts | 🗺 Roadmap | Pro+ |
| E.11 | Webhook on every event (reply sent / skipped / failed) | 🗺 Roadmap | Pro+ |
| E.12 | Custom-event export (CSV, JSON, BI tool) | 🗺 Roadmap | Enterprise |
| E.13 | Anomaly alerting (volume spike, error spike, cost spike) | 🗺 Roadmap | Pro+ |

## F. Workspace & team

| # | Feature | Status | Tier |
|---|---|---|---|
| F.1 | Auto-provisioned workspace on first Google sign-in | ✅ Shipped | All tiers |
| F.2 | One owner per workspace (the email that signed up) | ✅ Shipped | All tiers |
| F.3 | Four-step onboarding wizard (Set up workspace / Gmail / Knowledge / Review) — workspace name, persona, and classifier prompt combined into one Set-up card | ✅ Shipped | All tiers |
| F.4 | "Start over with a different account" during onboarding | ✅ Shipped | All tiers |
| F.5 | Soft-delete workspace (30-day grace before hard delete) | ✅ Shipped | All tiers |
| F.6 | Invite teammates as additional admins / viewers | 🗺 Roadmap | Pro+ |
| F.7 | Role-based access control (owner / admin / viewer / read-only) | 🗺 Roadmap | Pro+ |
| F.8 | Tenant-switcher for users in multiple workspaces | 🗺 Roadmap | All tiers |
| F.9 | Active sessions view + force-logout | 🗺 Roadmap | Enterprise |
| F.10 | SSO via SAML / OIDC (Okta / Google Workspace) | 🗺 Roadmap | Enterprise |
| F.11 | SCIM provisioning | 🗺 Roadmap | Enterprise |

## G. Security & compliance

| # | Feature | Status | Tier |
|---|---|---|---|
| G.1 | HMAC-signed session cookies (httpOnly, sameSite=lax, secure in prod) with server-side 7-day max-age check (a leaked-but-unrotated cookie is refused even if HMAC valid) | ✅ Shipped | All tiers |
| G.2 | Row-Level Security enabled on every per-tenant table | ✅ Shipped | All tiers |
| G.3 | Per-query tenant scoping via tenantScoped() helper | ✅ Shipped | All tiers |
| G.4 | Tenant isolation integration test (verifies no cross-tenant leakage) | ✅ Shipped | All tiers |
| G.5 | Per-IP signin rate limit (5/hour) on `/oauth/signin` | ✅ Shipped | All tiers |
| G.6 | OAuth refresh + access tokens encrypted at rest with AES-256-GCM (random IV per encrypt, GCM auth tag, `v1:` versioned format). Legacy plaintext rows opportunistically re-encrypted on next read. | ✅ Shipped | All tiers |
| G.7 | CSRF protection: double-submit token pattern (HMAC-signed `hiagents_csrf` cookie + `X-CSRF-Token` header) enforced on every state-changing route | ✅ Shipped | All tiers |
| G.8 | Content Security Policy + X-Content-Type-Options + X-Frame-Options DENY + Referrer-Policy + Permissions-Policy on every response; HSTS in production | ✅ Shipped | All tiers |
| G.9 | OAuth state nonce — every `/oauth/signin` and `/oauth/start` mints a 16-byte signed nonce in a 10-minute httpOnly cookie; `/oauth/callback` rejects on mismatch (defends against forged-callback phishing) | ✅ Shipped | All tiers |
| G.10 | Output-side XSS escaping on user-controlled fields (workspace name) before innerHTML injection | ✅ Shipped | All tiers |
| G.11 | Zod schema validation on every settings PUT with `.strict()` (rejects unknown keys, prevents JSONB-smuggle attacks like `superAdmin: true`) | ✅ Shipped | All tiers |
| G.12 | Consistent error envelope (`{ error: machine-code, message: user-friendly }`) — no stack traces or internal IDs leak to the client; server-side logging of full context | ✅ Shipped | All tiers |
| G.13 | Audit log of every auth event (signin, signout, gmail.connected, tenant.provisioned) with IP recorded | ✅ Shipped | All tiers |
| G.14 | Body-parser hardening — 256kb JSON cap (multer keeps its 25MB cap for PDF uploads), `entity.too.large` and JSON parse errors mapped to friendly envelope | ✅ Shipped | All tiers |
| G.15 | Log PII redaction (mask email addresses + body text in logs) | 🗺 Roadmap | All tiers |
| G.16 | Session revocation on membership change (currently capped by 30s tenant cache) | 🗺 Roadmap | All tiers |
| G.17 | Data export endpoint ("download my data" for GDPR) | 🗺 Roadmap | All tiers |
| G.18 | Hard-delete-on-demand (GDPR right to be forgotten, bypass 30-day grace) | 🗺 Roadmap | All tiers |
| G.19 | Audit log retention policy (90-day body-text wipe) | 🗺 Roadmap | All tiers |
| G.20 | SOC 2 Type II certification | 🗺 Roadmap | Enterprise |
| G.21 | HIPAA-ready (BAA available) | 🗺 Roadmap | Enterprise |
| G.22 | GDPR / Data Processing Agreement | 🗺 Roadmap | Pro+ |
| G.23 | Data residency controls (EU / US / APAC region pinning) | 🗺 Roadmap | Enterprise |
| G.24 | Customer-managed encryption keys (BYOK) | ❓ Considering | Enterprise |
| G.25 | 2FA on admin sign-in | ❓ Considering — Google sign-in is the only auth path, so 2FA is delegated to the user's Google account | All tiers |

## H. Configuration & operator controls

| # | Feature | Status | Tier |
|---|---|---|---|
| H.1 | Per-tenant settings UI: persona, retrieval (threshold + top-K), classifier prompt, auto-send, pause toggle, danger-zone delete | ✅ Shipped | All tiers |
| H.2 | Operator-controlled reply + classifier model (no tenant dropdown; edit `defaultTenantSettings()` to change) | ✅ Shipped | All tiers |
| H.3 | Configurable similarity threshold + top-K | ✅ Shipped | All tiers |
| H.4 | Per-tenant rate-limit knobs (daily email cap, per-sender cap, spend cap) | ✅ Shipped | All tiers |
| H.5 | Bring-your-own OpenRouter key (per-tenant cost attribution) | 🗺 Roadmap | Pro+ |
| H.6 | Bring-your-own OpenAI / Anthropic / Google key | 🗺 Roadmap | Pro+ |
| H.7 | Custom moderation rules (deny list of phrases bot should never use) | 🗺 Roadmap | Pro+ |
| H.8 | Webhook to override classifier verdict ("send all questions about X to me first") | 🗺 Roadmap | Pro+ |
| H.9 | Scheduled pause ("no replies after 6pm Friday") | 🗺 Roadmap | All tiers |
| H.10 | A/B testing of two reply models / tones | ❓ Considering | Pro+ |

## I. Reporting & analytics

| # | Feature | Status | Tier |
|---|---|---|---|
| I.1 | Per-model token + cost rollup (last 30 days) | ✅ Shipped | All tiers |
| I.2 | Activity counts (sent / skipped / failed, last 7 days) | ✅ Shipped | All tiers |
| I.3 | Weekly email digest of activity | 🗺 Roadmap | All tiers |
| I.4 | Monthly invoice with usage breakdown | 🗺 Roadmap | Pro+ |
| I.5 | Reply quality scorer (model-graded "would a human have replied this way?") | 🗺 Roadmap | Pro+ |
| I.6 | Customer satisfaction tracking (CSAT signal from inbound follow-up sentiment) | 🗺 Roadmap | Pro+ |
| I.7 | Cohort analysis ("how is reply quality trending by topic?") | 🗺 Roadmap | Enterprise |
| I.8 | Custom dashboards / BI export | 🗺 Roadmap | Enterprise |

## J. Integrations

| # | Feature | Status | Tier |
|---|---|---|---|
| J.1 | Gmail / Google Workspace | ✅ Shipped | All tiers |
| J.2 | Outlook / Microsoft 365 | 🗺 Roadmap | Pro+ |
| J.3 | Slack notifications | 🗺 Roadmap | Pro+ |
| J.4 | Zapier / Make webhook compatibility | 🗺 Roadmap | Pro+ |
| J.5 | Salesforce / HubSpot CRM sync (write reply log back to contact record) | 🗺 Roadmap | Pro+ |
| J.6 | Zendesk / Front / Help Scout (route flagged replies into your support tool) | 🗺 Roadmap | Pro+ |
| J.7 | Generic webhook API | 🗺 Roadmap | Pro+ |
| J.8 | REST API for programmatic KB + reply management | 🗺 Roadmap | Pro+ |

## K. Deployment & ops

| # | Feature | Status | Tier |
|---|---|---|---|
| K.1 | Managed SaaS hosting (on aiagencycorp.com) | ✅ Shipped | All tiers |
| K.2 | Multi-tenant single deployment (auto-provisioned workspace per email) | ✅ Shipped | All tiers |
| K.3 | Health endpoint for uptime monitoring | ✅ Shipped | All tiers |
| K.4 | PM2 + nginx self-hosted option (Docker compose available) | ✅ Shipped | (open source) |
| K.4a | Graceful SIGTERM/SIGINT shutdown (15s drain) — pm2 reloads don't cut in-flight requests or leave half-processed messages | ✅ Shipped | All tiers |
| K.4b | Concurrent poller (cap 10 tenants per tick) with explicit undici socket pool (`SUPABASE_MAX_SOCKETS`, default 32) so a 100-tenant deployment runs in ~2s per tick without thundering-herd against Gmail / OpenRouter / Supabase | ✅ Shipped | All tiers |
| K.4c | In-process tenant lookup cache (30s TTL with invalidate-on-write) — cuts ~80% of `memberships JOIN tenants` round-trips on active admin use | ✅ Shipped | All tiers |
| K.4d | Gmail label-id cache per tenant (eliminates a `labels.list` API call per processed message) | ✅ Shipped | All tiers |
| K.5 | 99.9% uptime SLA | 🗺 Roadmap | Pro+ |
| K.6 | 99.99% uptime SLA | 🗺 Roadmap | Enterprise |
| K.7 | Self-hosted "single tenant" option (your VPS, your Supabase) | 🗺 Roadmap | Enterprise |
| K.8 | On-prem / VPC deployment | ❓ Considering | Enterprise |
| K.9 | Dedicated support channel (Slack Connect) | 🗺 Roadmap | Enterprise |
| K.10 | White-label / reseller mode | 🗺 Roadmap | Pro+ |

---

## Suggested pricing tiers (draft)

This is a starting point — actual prices need market testing.

### Starter — $29/month

For solo operators or small teams handling under 200 customer emails a month.

- Everything in section A (core email automation)
- Everything in section B (knowledge base) at default caps
- C.1, C.2, C.3 (basic persona) — model is operator-set, no tenant override
- All of D (safety & guardrails)
- E.1–E.5 (basic activity + KPIs)
- F.1–F.5 (single-owner workspace)
- G.1–G.14 (core security: HMAC sessions + server-side expiry, RLS, encryption at rest, CSRF, CSP, OAuth state nonce, XSS escaping, schema validation, error envelope, body-parser hardening)
- H.1–H.4 (settings UI)
- I.1, I.2 (basic reporting)
- J.1 (Gmail)
- K.1–K.3 (managed hosting)

Caps: 200 emails/day, 5K KB chunks, $5/day LLM spend, 25MB PDF size, 1 admin.

### Pro — $99/month

For service businesses with 500–5000 emails/month who need multi-admin and integrations.

Everything in Starter plus:

- A.10, A.11, A.13 (training wheels, multi-language, push notifications)
- B.9, B.10, B.11, B.12 (DOCX/Drive/URL/image ingest)
- C.4, C.7, C.8 (custom classifier prompt, voice training, per-recipient tone)
- D.16 (custom safety rules)
- E.6, E.8, E.10, E.11, E.13 (usage rollup, real-time stream, Slack, webhooks, alerts)
- F.6, F.7, F.8 (invites, RBAC, tenant switcher)
- G.15, G.22 (PII redaction, GDPR DPA)
- H.5, H.6, H.7, H.8 (BYOK, custom moderation, classifier override)
- I.3–I.6 (digests, invoices, quality scorer, CSAT)
- J.2–J.7 (Outlook, Slack, Zapier, CRM, support tools)
- K.5, K.10 (99.9% SLA, white-label)

Caps: 5K emails/day, 50K KB chunks, $50/day LLM spend, 100MB PDF, 10 admins.

### Enterprise — custom pricing

For regulated industries, large operations, or specific compliance needs.

Everything in Pro plus:

- F.9, F.10, F.11 (sessions, SAML, SCIM)
- G.20, G.21, G.23 (SOC 2, HIPAA, data residency)
- I.7, I.8 (cohort analysis, BI export)
- K.6, K.7, K.8, K.9 (99.99% SLA, self-hosted, on-prem, dedicated support)
- Custom SLA, custom DPA, custom security review
- Direct line to the founding team

Caps: unlimited (negotiated per contract).

---

## How to use this doc

**When sales asks "do you do X?":** check this file. If X is ✅, say yes; if 🗺, say "on the roadmap, here's the rough timing"; if ❓, say "we're evaluating — what's your use case?"; if not listed, log it and revisit.

**When a feature ships:** flip its status to ✅, push an update to this file, then update the marketing pricing page from it.

**When considering a new feature:** add it as ❓ with a one-line use case. Discuss in weekly planning. Promote to 🗺 if direction is agreed; otherwise leave or remove.

**Quarterly review:** any feature at 🗺 for over six months gets a hard look. Either promote to 🛠 or downgrade to ❓ or remove. Roadmaps that don't move are noise.
