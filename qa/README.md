# QA suite

Two layers — automated Playwright tests for everything that doesn't need a real Google account, and a manual checklist (`MANUAL-QA-CHECKLIST.md`) for the auth-gated and pipeline flows.

## What's covered automatically

| Spec | What it asserts | Auth needed |
|---|---|---|
| `01-marketing.spec.ts` | hiagents.digital: hero, anchors, FAQ expand, no app-link leakage, sitemap, robots, OG image, JSON-LD shape, no console errors | none |
| `02-marketing-form.spec.ts` | Waitlist API: end-to-end Supabase write + Resend `notify` envelope. **Skipped by default** — opt in to actually drop a row. | none |
| `03-app-public.spec.ts` | bot.aiagencycorp.com: `/health`, login-page render, redirect-when-unauth, API 401 envelopes, CSP / HSTS / X-Frame-Options / Referrer-Policy headers, CSRF guard | none |
| `04-oauth-errors.spec.ts` | Every `/oauth/callback?error=…` path renders the styled error card with the right back-button target and copy. Regression suite for commits `d313c55` and `5d657e1`. | none |

24 tests, runs in ~30s headed.

## Run

```bash
# from this qa/ dir
npm install            # one-time
npx playwright install chromium    # one-time
npm test               # headed run — windows pop up so you can watch
npm run test:report    # open HTML report after a run
```

Override the targets via env (useful for preview deploys):

```bash
HIAGENTS_MARKETING_URL=https://hiagents-staging.vercel.app \
HIAGENTS_APP_URL=https://staging.bot.aiagencycorp.com \
npm test
```

To also exercise the live waitlist API (drops a real Supabase row + may trigger a real Resend email):

```bash
HIAGENTS_QA_SUBMIT=1 npx playwright test 02-marketing-form
```

## When something fails

Playwright captures a screenshot, a video, and a trace zip on every failure under `test-results/`. To inspect a trace interactively:

```bash
npx playwright show-trace test-results/<failed-test-folder>/trace.zip
```

The HTML report (`playwright-report/`) has the same artefacts plus a side-by-side view.

## Manual checklist

`MANUAL-QA-CHECKLIST.md` covers everything Playwright can't reach without real Google credentials + real email traffic — the full onboarding flow, dashboard tile saves, pause/resume kill-switch, end-to-end pipeline (send an email, verify a reply), pagination, the moderation-regression check from the recent CLI-answer false-positive, and sign-out / re-sign-in.

Run that manually before any cohort onboarding. Anything that fails: screenshot + step number + relevant pm2 log slice.
