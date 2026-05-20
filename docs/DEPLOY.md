# Deploy guide (Hostinger VPS or any Linux box with Docker)

## Prerequisites

- A VPS with a public IP (Hostinger VPS works).
- A domain (or subdomain) pointed at the VPS IP via an A record (e.g., `bot.clientdomain.com` → `198.51.100.7`).
- A Supabase project (free tier is fine to start).
- Docker + Docker Compose installed on the VPS.
- A Google Cloud OAuth client (see [GMAIL-OAUTH-SETUP.md](GMAIL-OAUTH-SETUP.md)).

## Recommended hosting pattern (multi-client deployments)

If you're hosting deployments for multiple clients, host each on a subdomain of **your** domain (not the client's), e.g.:

- `bot-acme.aiagencycorp.com` → Acme's deployment
- `bot-foo.aiagencycorp.com` → Foo's deployment

This means YOU add the DNS A record (zero friction for the client) and you control the SSL termination. The client only needs to (a) click "Connect Gmail" in the admin UI and (b) drop their PDFs in. No DNS, no infrastructure on their side.

Per new client at your end:
1. Add the DNS A record under your domain
2. Add the new callback URL to your OAuth app's "Authorized redirect URIs"
3. Add the client's Gmail to the OAuth "Test users" list
4. Provision a VPS (or new directory on a shared VPS), copy `.env.example` → `.env`, fill in
5. `docker compose up -d --build`

## One-time VPS prep

```bash
ssh root@<vps-ip>

# Install Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Confirm
docker --version
docker compose version
```

## Deploy this app

```bash
# On the VPS
git clone https://github.com/<your-org>/inbox-ai.git
cd inbox-ai

# Configure
cp .env.example .env
nano .env   # fill in all values; pay attention to DOMAIN, BASE_URL, GOOGLE_REDIRECT_URI

# Apply Supabase schema:
# Copy supabase/migrations/001_init.sql contents into the Supabase SQL editor for your project, then click "Run".

# Bring up the stack
docker compose up -d --build

# Confirm health
curl -k https://${DOMAIN}/health
# Should return: {"ok":true,"ts":"..."}
```

Caddy will auto-provision a Let's Encrypt cert on first request to your `DOMAIN`.

## Connect Gmail

1. Open `https://bot.<yourdomain>.com/admin`.
2. Log in with `ADMIN_PASSWORD`.
3. Click "Connect / reconnect Gmail".
4. Complete the OAuth consent (note the unverified-app warning is expected — see GMAIL-OAUTH-SETUP.md).
5. Verify the dashboard shows "Connected: you@yourdomain.com".

## Upload knowledge base

1. From the admin page, drag PDFs into the upload area.
2. Wait a few seconds — status flips from `pending` to `ingested` and shows the chunk count.

## Verify end-to-end

Send a test email from a different address to your mailbox with a question that should be answerable from your PDFs. Within ~60s the bot should reply, and the admin "Recent activity" table should show the message with `reply_status: sent`.

## Updating

```bash
cd inbox-ai
git pull
docker compose up -d --build
```

## Logs

```bash
docker compose logs -f app
docker compose logs -f caddy
```

## Tuning

Edit `.env` and `docker compose up -d` to restart:
- `SIMILARITY_THRESHOLD` — raise to be stricter about what counts as a KB-supported question (default 0.7).
- `TOP_K` — how many chunks to retrieve (default 5).
- `POLL_INTERVAL_SECONDS` — how often to poll Gmail (default 60).
- `TONE`, `SIGNATURE`, `COMPANY_DESCRIPTION` — persona.

---

## SaaS-mode deployment notes

inbox-ai is now multi-tenant. A single deployment serves N tenants. Steps that change from the single-tenant guide:

- **No `ADMIN_EMAILS` env var.** Anyone with a Google account can sign in and gets an auto-provisioned tenant.
- **No tenant-specific persona / model / threshold env vars.** All per-tenant config lives in the `tenants.settings` JSONB column and is edited via the Settings UI. The env-level defaults (`SIMILARITY_THRESHOLD`, `TONE`, `SIGNATURE`, `COMPANY_DESCRIPTION`, etc.) are NO LONGER read by the running pipeline — only `defaultTenantSettings()` in code matters.
- **Single deployment, single domain.** All tenants share `bot.aiagencycorp.com`. Tenant context is derived from the signed-in user's email.
- **Pre-add OAuth redirect URI**: `https://bot.aiagencycorp.com/oauth/callback` (just one — used for both sign-in and mailbox-connect flows, disambiguated via `state` param).
- **Run migration 002** in the Supabase SQL editor before redeploying — see [MIGRATION-002-RUNBOOK.md](MIGRATION-002-RUNBOOK.md).
- **One Supabase project**, no longer one-per-client. RLS + per-query tenant scoping enforce isolation.
- **New routes mounted in `server.ts`**: `/admin/api/settings` (settings + usage + delete) and `/admin/onboarding` (wizard).
- **Daily cleanup cron** hard-deletes soft-deleted tenants after 30 days (runs at 03:00 UTC).

## Per-tenant cost attribution

OpenRouter doesn't support sub-keys. Cost tracking lives in our `llm_usage` table — every `chat()` and `embed()` call records `{tenant_id, model, kind, tokens, cost_usd}`. To query "how much has tenant X spent in the last 30 days":

```sql
select model, sum(total_tokens) as tokens, sum(cost_usd) as cost
from llm_usage
where tenant_id = '<id>'
  and created_at > now() - interval '30 days'
group by model
order by cost desc;
```

The Settings UI surfaces this per tenant.

## Tenant isolation

Every query that touches a per-tenant table is filtered by `tenant_id` in code. RLS is enabled on every table as defense-in-depth (the app uses the service role key which bypasses RLS, but RLS catches any accidental anon-key access).

`tests/integration/tenant-isolation.test.ts` provisions two tenants, inserts a doc + message in each, and asserts neither tenant sees the other's data. Run against a test Supabase project with `TEST_SUPABASE=1 npm test`.

## OAuth verification

In SaaS mode every new tenant sees Google's "Google hasn't verified this app" warning during sign-in. Submit the OAuth consent screen for verification before any real marketing push:
1. Privacy policy URL (host on `aiagencycorp.com/privacy`)
2. Terms of service URL (`aiagencycorp.com/terms`)
3. Demo video showing data use
4. Wait ~4-6 weeks for review

Until verification, the workflow still works for users who click "Advanced → Continue" — but conversion at scale will suffer.
