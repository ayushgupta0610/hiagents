# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.** A public issue tips off opportunistic scanners before maintainers have a chance to patch.

Use one of these private channels instead:

- **GitHub Security Advisories** — preferred. From the repo's **Security** tab → **Report a vulnerability**. This creates a private thread visible only to maintainers and (eventually) the people you invite to coordinate disclosure.
- **Email** — if the deployment you're reporting against has set a `SUPPORT_EMAIL`, use it. Otherwise reach out to the maintainer listed in `package.json`'s `author` field.

Include in the report:

- What you found (one-sentence summary).
- Reproduction steps — the smallest example that demonstrates the issue.
- The impact you think it has (data exposure, privilege escalation, denial of service, etc.).
- The version / commit SHA you tested against.
- Any suggested mitigation, if you have one.

You don't need to have a fix. A solid reproduction is more useful than a half-finished patch.

## Response timeline

We aim to:

- **Acknowledge within 3 business days** — at minimum, a "we got it, we're looking."
- **Triage within 7 business days** — confirm or refute, give a rough severity, and tell you whether we're treating it as a security fix or a normal bug.
- **Ship a patched release within 30 days** for confirmed high/critical issues, faster if exploitation is observed in the wild.

These are targets, not contractual commitments. If you've been waiting longer than expected and haven't heard back, please follow up — sometimes mail gets lost.

## Disclosure

We follow coordinated disclosure. Once a fix is shipped and a reasonable window has passed for users to update (typically 7-14 days for self-hosted), we publish the advisory with credit to the reporter (unless you'd prefer to stay anonymous — say so in the report).

We will not pursue legal action against good-faith security researchers who:

- Avoid privacy violations, data destruction, and service disruption.
- Do not exploit the vulnerability beyond what's needed to demonstrate it.
- Give us a reasonable chance to fix the issue before public disclosure.

## Scope

In scope:

- The application code in this repository (`src/`)
- The Supabase migrations and any SQL we ship
- The default `.env.example` configuration
- Build / deployment artifacts (`Dockerfile`, `ecosystem.config.cjs`, `Caddyfile`, nginx examples)

Out of scope:

- Third-party services we depend on (Supabase, Google OAuth, OpenRouter, npm packages) — report directly to them.
- Vulnerabilities that require an attacker to already have administrative access to a tenant's account.
- Social-engineering attacks on operators.
- Issues that only affect a forked, modified, or out-of-date deployment.
- Anything labeled "🗺 Roadmap" or "❓ Considering" in [docs/FEATURES.md](docs/FEATURES.md) — those aren't shipped yet.

If you're unsure whether something is in scope, report it privately and we'll tell you.

## Already-considered classes

The following are documented attack surfaces with current mitigations described in [docs/SAFETY-AUDIT.md](docs/SAFETY-AUDIT.md). Reports that don't go beyond what's already covered there are unlikely to be treated as new vulnerabilities, though we'd still like to know if you find a gap:

- Prompt injection (inbound risk classifier + "KB context is untrusted" in the reply-generation prompt).
- Session-cookie forgery (HMAC-SHA256 + server-side max-age check).
- CSRF (double-submit token pattern on every state-changing route).
- OAuth callback forgery (state-nonce defense).
- OAuth-token compromise at rest (AES-256-GCM with per-encrypt random IV).
- Header injection on outbound mail (header sanitization on `To` / `Subject` / `In-Reply-To`).
- Cross-tenant data leakage (per-query scoping + RLS, regression test in `tests/integration/tenant-isolation.test.ts`).

If you've broken any of these, that's a real bug and we want to know.
