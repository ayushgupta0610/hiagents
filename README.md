# inbox-ai

Multi-tenant SaaS that auto-replies to client emails using a PDF-backed knowledge base. Anyone with a Google account can sign up, gets their own auto-provisioned workspace, configures their bot via a wizard, and operates fully isolated from every other tenant — all on a single deployment.

## How it works (multi-tenant SaaS)

A single deployment serves many tenants. Anyone can sign in with Google and gets their own auto-provisioned tenant: their own knowledge base, their own Gmail connection, their own classifier and reply config. Tenant scoping is enforced at every query, with Postgres RLS as defense-in-depth.

Per tenant, the bot polls Gmail every 60s and for each new email:

1. **Loop guard** — skip if it's auto-generated (newsletters, autoresponders, list mail).
2. **Thread guard** — skip if the owner has manually replied in this thread already.
3. **Classifier** — a cheap LLM (`gpt-4o-mini` by default) labels the email as a client query or not. Per-tenant prompt override available.
4. **Retrieve** — embed the email, pull top-k chunks from `kb_chunks` via pgvector, scoped by `tenant_id`.
5. **Generate** — the tenant's chosen reply model (default `deepseek/deepseek-v4-flash`) drafts a reply grounded in the retrieved chunks + the tenant's persona settings.
6. **Send** — Gmail API sends the reply in-thread (or saves as draft if `autoSend=false`).
7. **Label + audit** — apply `inbox-ai/replied` label; log the full decision trail to `messages` (scoped to tenant) and every LLM call to `llm_usage` for cost attribution.

If retrieval finds nothing above the tenant's similarity threshold, the bot does NOT reply (logged as `no-kb-match`).

## Quick start (operator)

1. Copy env template: `cp .env.example .env` and fill in **deployment-level** values only (Supabase, OpenRouter, Google OAuth, admin password).
2. Apply Supabase migrations in order: `001_init.sql`, then `002_multi_tenant.sql` (see `docs/MIGRATION-002-RUNBOOK.md`).
3. Set up Google OAuth — see [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md).
4. Deploy — see [docs/DEPLOY.md](docs/DEPLOY.md).
5. Open `https://bot.<yourdomain>.com/admin/login` and sign in with Google. You'll be auto-provisioned a tenant and walked through the onboarding wizard.

## How a new user signs up

1. Visit `https://bot.<yourdomain>.com/admin/login`
2. Click "Continue with Google"
3. New email → new tenant + owner membership auto-provisioned
4. Walked through the onboarding wizard:
   - Welcome (workspace name)
   - Connect Gmail (mailbox OAuth)
   - Persona (tone / signature / company description)
   - Knowledge base (upload PDFs)
   - Classifier prompt (optional)
   - Done

After onboarding completes, the poller starts polling the new tenant's Gmail.

See [docs/ONBOARDING-FLOW.md](docs/ONBOARDING-FLOW.md) for the technical details.

## Development

```bash
npm install
cp .env.example .env  # then fill in
npm run dev
```

## Tests

```bash
npm test                                # unit tests
TEST_SUPABASE=1 npm test                # also run tenant-isolation integration tests
```
