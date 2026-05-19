# inbox-ai

AI-powered email auto-responder backed by a PDF knowledge base. One Docker stack per client deployment.

## Quick start

1. Copy env template: `cp .env.example .env` and fill in.
2. Apply Supabase migration: paste `supabase/migrations/001_init.sql` into your Supabase SQL editor.
3. Set up Google OAuth — see [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md).
4. Deploy — see [docs/DEPLOY.md](docs/DEPLOY.md).
5. Open `https://bot.<yourdomain>.com/admin`, log in with `ADMIN_PASSWORD`, connect Gmail, upload your PDFs.

## How it works

Every 60 seconds the server polls Gmail for unread inbox mail. For each message:

1. **Loop guard** — skip if it's auto-generated (newsletters, autoresponders, list mail).
2. **Thread guard** — skip if the owner has manually replied in this thread already.
3. **Classifier** — a cheap LLM (`gpt-4o-mini`) labels the email as a client query or not.
4. **Retrieve** — embed the email, pull top-k chunks from `kb_chunks` via pgvector.
5. **Generate** — Claude Sonnet drafts a reply grounded in the retrieved chunks.
6. **Send** — Gmail API sends the reply in-thread.
7. **Label + audit** — apply `inbox-ai/replied` label; log the full decision trail to `messages`.

If retrieval finds nothing above `SIMILARITY_THRESHOLD`, the bot does NOT reply (logged as `no-kb-match`).

## Development

```bash
npm install
cp .env.example .env  # then fill in
npm run dev
```

## Tests

```bash
npm test
```
