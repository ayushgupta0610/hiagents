# Onboarding Flow

When a user signs in for the first time via Google:

1. **`/oauth/callback?state=login`** — Google returns to us with the user's email
2. **Look up `memberships where email = ?`** — if none, `provisionTenant(email)` creates a new `tenants` row + `memberships(role=owner)` row
3. **Set session cookie** carrying `(email, tenant_id, ts, HMAC)`
4. **Redirect to `/admin/onboarding`** (or `/admin` if onboarding already complete)
5. **Wizard steps** (`src/ui/onboarding.html`):
   - **Welcome** — sets `tenants.name`
   - **Mailbox** — runs the existing mailbox-connect OAuth flow with `state=mailbox:<tenant_id>`. On return, polls `/admin/onboarding/api/state` until `mailbox: true`.
   - **Persona** — `signature`, `tone`, `companyDescription` → `tenant.settings.persona`
   - **KB** — uploads at least one PDF; reuses `/admin/api/documents`
   - **Classifier** — optional custom prompt (max 2000 chars) → `tenant.settings.classifier.prompt`
   - **Done** — sets `tenants.onboarding_completed_at`
6. **Redirect to `/admin`**

If a user revisits `/admin` while `onboarding_completed_at` is null, they're redirected to the wizard. The poller skips tenants whose onboarding isn't complete.

## Provisioning details

`provisionTenant(email)` is in `src/tenant/store.ts`:
1. Derives a tenant `name` from the email's local part (e.g., `ayushgupta0610@gmail.com` → `ayushgupta0610`)
2. Derives a unique `slug` by appending `-2`, `-3`, … if needed
3. Inserts a `tenants` row with default settings (`defaultTenantSettings()`)
4. Inserts a `memberships` row with `role=owner`
5. Returns the new tenant

## Per-tenant audit log

Every onboarding step + every settings change writes to `audit_log` via `src/tenant/audit.ts`. Use this to debug "who changed what when".

```sql
select created_at, action, actor_email, metadata
from audit_log
where tenant_id = '<id>'
order by created_at desc;
```

## Session cookie

Cookie format: `<ts>.<base64(email)>.<base64(tenantId)>.<HMAC>`. HMAC uses `SESSION_SECRET` (≥32 chars; generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`). `requireAdmin` validates HMAC, enforces a server-side max-age of 7 days (a leaked-but-unrotated cookie is refused even if the signature is intact), and pulls fresh membership data on every request — revoking a membership invalidates the cookie on next request, capped by the 30-second in-process tenant cache.

A second non-httpOnly cookie `inbox_ai_csrf` holds a HMAC-signed CSRF token that the admin UI echoes via `X-CSRF-Token` on every state-changing request. `csrfGuard` middleware rejects POST/PUT/DELETE without a matching pair.

## OAuth state nonce

Every `/oauth/signin` and `/oauth/start` mints a 16-byte random nonce, signs it with `SESSION_SECRET`, and stores it in a 10-minute httpOnly cookie scoped to `/oauth`. `/oauth/callback` consumes the cookie and rejects any state mismatch — defends against forged-callback phishing where a victim's browser is lured to `/oauth/callback` with an attacker's `code` + `state`.

## Token storage

`oauth_tokens.access_token` and `oauth_tokens.refresh_token` are encrypted at rest with AES-256-GCM using `TOKEN_ENCRYPTION_KEY` (a 32-byte key, base64-encoded; ≥40 chars). Format is `v1:base64(iv || tag || ciphertext)` with a random 12-byte IV per encrypt. Rows written before encryption shipped are opportunistically re-encrypted on the next read of that mailbox — no migration step is required.
