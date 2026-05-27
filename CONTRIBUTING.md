# Contributing to hiagents

Thanks for considering a contribution. This doc covers how to get a dev environment running, the patterns we follow, and how PRs land.

## Getting started

You'll need:

- Node 20+
- A Supabase project (free tier is fine — see `supabase/migrations/` for the SQL to run)
- An OpenRouter API key
- A Google Cloud OAuth client (see [docs/GMAIL-OAUTH-SETUP.md](docs/GMAIL-OAUTH-SETUP.md))

```bash
git clone <your-fork-url> hiagents
cd hiagents
npm install
cp .env.example .env       # fill in values; generation commands inline
npm run dev                # tsx watch src/server.ts on :3000
```

## Filing an issue

Before opening one, please grep existing issues (open + closed) — there's a good chance someone hit the same thing.

- **Bug?** Use the bug-report template. Include reproduction steps and what you expected vs. what happened.
- **Feature idea?** Use the feature-request template. Start with the problem you're trying to solve, not the solution.
- **Security vulnerability?** Do NOT open a public issue. See [SECURITY.md](SECURITY.md) for the private disclosure channel.
- **Question?** GitHub Discussions if it's a "how do I" question. Issues are for bugs and feature work.

## Making a change

For anything non-trivial, open an issue first. A 10-minute conversation about approach saves a 4-hour rewrite of a misaimed PR.

Before submitting:

```bash
npm test                    # unit + integration (offline ones)
npm run build               # TypeScript compile
```

For UI changes, also run the dev server and click through the affected screen — type-checking won't catch a regressed flow.

## Code style

We follow the patterns documented in [CLAUDE.md](CLAUDE.md) "Patterns to follow". The short version:

- **Small files.** Aim for one clear responsibility per file, prefer <400 lines.
- **Immutable updates.** Return new objects, don't mutate in place.
- **Error envelope.** All JSON API failures go through `sendError(res, status, { code, message })` from `src/lib/errors.ts`. Never leak stack traces to the client.
- **CSRF on every write.** `csrfGuard` middleware after `requireAdmin` on every POST/PUT/DELETE route.
- **Tenant scoping.** Every per-tenant query is filtered by `tenant_id` in code. RLS is on as defense-in-depth.
- **Tokens are encrypted.** Never touch `oauth_tokens.access_token` / `refresh_token` without `encryptToken` / `decryptToken` from `src/lib/crypto.ts`.
- **Header sanitization.** Anything that ends up in a raw email header goes through `sanitizeHeader()` from `src/providers/gmail.ts`.
- **Default to no comments.** Code should be self-documenting through naming. Add a comment only when the *why* is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug).

## Tests

We use Vitest. New behavior gets a new test.

- **Unit tests** in `tests/unit/` — fast, offline, no real network.
- **Integration tests** in `tests/integration/` — exercise real Supabase and (sometimes) real LLM calls. Skipped by default; run with the env vars set:
  - `TEST_SUPABASE=1 npm test` — runs the tenant-isolation test against a real Supabase project
  - Live LLM-calling tests need `OPENROUTER_API_KEY` set in `.env.local`
- **E2E / QA suite** in `qa/` — Playwright headed Chrome. See [qa/README.md](qa/README.md).

If you change `src/pipeline/moderate.ts`, add at least one OK case and one FLAGGED case to the moderation integration test so we don't drift back into false-positives.

## Commit messages

Conventional commits. Type prefix + short description, body explains *why* if it's not obvious:

```
feat: support DOCX ingestion in addition to PDFs
fix: stop caching null results in findTenantForEmail
refactor: split oauth.ts into routes + state + errors
docs: clarify SUPPORT_EMAIL env var in deploy guide
test: add OK case for legitimate CLI answers
chore: bump undici to 8.4
```

Types we use: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

- Keep PRs small and focused. One logical change per PR is much easier to review.
- Use the PR template. Fill in the summary and the test plan — they help reviewers a lot.
- Link the issue you're closing (`Closes #123`).
- Don't combine "refactor the existing thing" with "add the new thing" in one PR if the refactor stands on its own — split them.
- Tests pass + build clean is required for merge. If something legitimately can't be tested (a real-world OAuth flow, a Gmail-API edge case), say so explicitly in the test plan.

## What we won't merge

Some things we've decided against; see CLAUDE.md "Things to NOT reintroduce" for the running list. The most common ones:

- Adding `markRead` or Gmail labels to processed mail (visual clutter in user's inbox).
- Adding a per-tenant model dropdown (operator decision, not user-facing).
- Adding password-fallback login (Google sign-in only).
- Restoring the blanket "no code or shell commands" moderator rule (false-positives).

If you think one of these decisions should be revisited, open a discussion before the PR — bring the use case.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, assume good intent, give specific feedback. Report concerns via the channel in that doc.

## License

By contributing, you agree your contributions are released under the project's [MIT License](LICENSE).
