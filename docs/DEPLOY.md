# Deploy guide (Hostinger VPS or any Linux box with Docker)

## Prerequisites

- A VPS with a public IP (Hostinger VPS works).
- A domain (or subdomain) pointed at the VPS IP via an A record (e.g., `bot.clientdomain.com` → `198.51.100.7`).
- A Supabase project (free tier is fine to start).
- Docker + Docker Compose installed on the VPS.
- A Google Cloud OAuth client (see [GMAIL-OAUTH-SETUP.md](GMAIL-OAUTH-SETUP.md)).

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
