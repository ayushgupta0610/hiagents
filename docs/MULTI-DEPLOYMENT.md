# Multi-deployment runbook

Running two (or more) independent hiagents instances on the same VPS, one per domain.
Same git repo, same VPS, **separate Supabase project, separate Google OAuth client, separate pm2 process, separate nginx vhost**. Existing customers on the original deployment stay untouched.

This doc is for the operator standing up a second instance. The original `docs/DEPLOY.md` still applies for the first one.

---

## When this pattern applies

- You already have one hiagents instance running for an existing customer (e.g. `bot.aiagencycorp.com`) and need to spin up a second under your own brand (`app.hiagents.digital`) without touching the first.
- You're hosting deployments for multiple clients, each on its own subdomain, and want clean isolation between their data.

If you only have one deployment and want to *swap* its domain, use `scripts/set-deploy-domain.sh` instead — that's for changing the canonical hostname of an existing instance, not adding a second one.

---

## Architecture

```
┌──────────────────────────  one Linux VPS  ──────────────────────────┐
│                                                                     │
│   /root/inbox-ai/                  /root/hiagents-app/              │
│   ├── .env  (port 3000)            ├── .env  (port 3001)            │
│   ├── ecosystem.config.cjs         ├── ecosystem.config.cjs         │
│   └── pm2 process: inbox-ai        └── pm2 process: hiagents-app    │
│                                                                     │
│                  ┌─────────  nginx  ─────────┐                      │
│                  │  bot.aiagencycorp.com →3000│                      │
│                  │  app.hiagents.digital →3001│                      │
│                  └────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
  Supabase project A                 Supabase project B
  Google OAuth client A              Google OAuth client B
  (existing customer tenants)        (new domain tenants)
```

Every per-instance setting is local to its own checkout — `.env`, `.deploy-domain`, `ecosystem.config.cjs`, the nginx vhost. The shared things: the codebase (git pull from same repo), the VPS kernel / cron daemon / nginx binary.

---

## Pre-flight

Before running any commands on the VPS, have these ready:

- [ ] **DNS A record** for the new hostname pointing at the VPS IP (e.g. `app.hiagents.digital` → `198.51.100.7`). Wait for propagation — `dig app.hiagents.digital` should return your VPS IP from any resolver.
- [ ] **New Supabase project** — `supabase.com` → New project named something distinctive (e.g. `hiagents-digital`). Note the Project URL and the `service_role` key.
- [ ] **Supabase migrations applied** on the new project — paste `supabase/migrations/001_init.sql` then `supabase/migrations/002_multi_tenant.sql` into the SQL editor, click Run on each.
- [ ] **New Google OAuth client** — Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application. Authorized redirect URI: `https://app.hiagents.digital/oauth/callback`. Authorized JavaScript origin: `https://app.hiagents.digital`. **Use a separate OAuth consent screen** for this client so verification can proceed independently of the existing client.
- [ ] **Two fresh secrets**, generated locally:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # SESSION_SECRET
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY
  ```
  Don't reuse the existing deployment's secrets — keeps a compromise of one from leaking into the other.

---

## Setup (on the VPS)

### 1. Clone into a parallel directory

```bash
cd /root
git clone git@github.com:ayushgupta0610/inbox-ai.git hiagents-app
cd hiagents-app
npm install
```

Don't run `npm run build` yet — we need `.env` first or the build can pick up wrong defaults.

### 2. `.env` for the new instance

```bash
cp .env.example .env
vim .env
```

Fill in **every** value below with values *from the new Supabase project + new Google OAuth client*:

```ini
PORT=3001                                            # MUST differ from the existing instance's port
NODE_ENV=production
BASE_URL=https://app.hiagents.digital
DOMAIN=app.hiagents.digital
GOOGLE_REDIRECT_URI=https://app.hiagents.digital/oauth/callback

SUPABASE_URL=https://<new-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...new...service-role-key...

OPENROUTER_API_KEY=sk-or-...                         # Can reuse the existing key if you want
                                                     # shared usage tracking, OR provision a
                                                     # separate one to track spend per domain.
GOOGLE_CLIENT_ID=...new.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...new...

SESSION_SECRET=...fresh-48-byte-base64...
TOKEN_ENCRYPTION_KEY=...fresh-32-byte-base64...

POLL_INTERVAL_SECONDS=60
```

### 3. Update the pm2 process name + the canonical-domain docs

The repo ships with `ecosystem.config.cjs` set to `name: 'inbox-ai'`. On this clone, change it once so the two pm2 processes don't collide:

```bash
sed -i "s/name: 'inbox-ai'/name: 'hiagents-app'/" ecosystem.config.cjs
```

Run the domain-swap script so the docs + example configs in THIS clone reflect the new hostname (the original `/root/inbox-ai/` clone is untouched):

```bash
scripts/set-deploy-domain.sh app.hiagents.digital
```

### 4. Build + start

```bash
npm run build
pm2 start ecosystem.config.cjs       # starts as "hiagents-app"
pm2 save                              # persist the new process across reboots
pm2 ls                                # should show both: "inbox-ai" + "hiagents-app", both online
```

### 5. nginx vhost

Create `/etc/nginx/sites-available/app.hiagents.digital` based on the multi-vhost template in `docs/nginx-vhost-multi.conf.example`. The minimum:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name app.hiagents.digital;

    client_max_body_size 30M;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3001;          # ← matches PORT in step 2
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then:

```bash
ln -s /etc/nginx/sites-available/app.hiagents.digital /etc/nginx/sites-enabled/
nginx -t                              # syntax check
systemctl reload nginx
certbot --nginx -d app.hiagents.digital   # provisions SSL + rewrites the vhost to add the 443 block
```

### 6. Verify

```bash
curl -s https://app.hiagents.digital/health
# expect: {"ok":true,"ts":"..."}

curl -sI https://app.hiagents.digital/admin/login | head -5
# expect: HTTP/1.1 200 OK + your security headers
```

Then open `https://app.hiagents.digital/admin/login` in a browser, sign in with a Google account on the new client's Test Users list, and walk through the onboarding wizard. The new deployment should auto-provision a workspace in the *new* Supabase project — **the existing customer on `bot.aiagencycorp.com` does not see this tenant, and vice versa**.

---

## Day-to-day deploys (both instances independent)

```bash
# Existing customer — unchanged from before
cd /root/inbox-ai && git pull && npm install && npm run build && pm2 restart inbox-ai

# New domain
cd /root/hiagents-app && git pull && npm install && npm run build && pm2 restart hiagents-app
```

Each `git pull` brings in the latest main; the `.env`, `.deploy-domain`, and `ecosystem.config.cjs` edits you made locally stay (they're gitignored or are uncommitted local changes — re-running `git pull` won't clobber them).

Logs per instance:

```bash
pm2 logs inbox-ai --lines 50
pm2 logs hiagents-app --lines 50
```

---

## Common pitfalls

- **Same port on both instances** — second `pm2 start` will fail with `EADDRINUSE`. Always check PORT in the new `.env` differs from the existing one.
- **OAuth redirect URI mismatch** — Google rejects sign-in with `redirect_uri_mismatch` if `GOOGLE_REDIRECT_URI` in `.env` doesn't exactly match an entry in the Google OAuth client's Authorized redirect URIs. The new client needs `https://app.hiagents.digital/oauth/callback` listed.
- **Forgot to change pm2 name** — both clones try to register as `inbox-ai`; the second `pm2 start` overwrites the first one's registration silently. Always edit `ecosystem.config.cjs` in step 3 before `pm2 start`.
- **Same Supabase project for both** — defeats the "clean isolation" decision. If a Google account is on the Test Users list of *both* OAuth clients, signing in to either domain finds the same tenant. Only ever use a shared Supabase if you explicitly want that.
- **`scripts/set-deploy-domain.sh` run in the wrong checkout** — operates on the directory it's run from. Run it only in the *new* clone, not the existing one.
- **Cron-poller email loops** — both instances poll Gmail every 60s. If you accidentally connected the same Gmail to both (different OAuth clients can both receive consent on the same Gmail), they'll race to reply and you'll see duplicated replies. Don't connect the same mailbox to both deployments.

---

## When you want to consolidate later

If the existing customer ever leaves or moves to the new domain, decommission cleanly:

```bash
pm2 stop inbox-ai
pm2 delete inbox-ai
rm /etc/nginx/sites-enabled/bot.aiagencycorp.com
systemctl reload nginx
# (Supabase project A can be deleted or archived once you're sure no data is needed)
```

Keep the git checkout around for a week as insurance before removing `/root/inbox-ai/` entirely.
