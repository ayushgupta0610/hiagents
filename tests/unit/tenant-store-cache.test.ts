import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the "test-user can't sign in" bug from 2026-05-26.
//
// Repro:
//   1. Brand new email signs in via Google OAuth
//   2. /oauth/callback calls findTenantForEmail(email) → null (no tenant yet)
//   3. /oauth/callback calls provisionTenant(email) → creates the tenant
//   4. /oauth/callback issues a session cookie and redirects to /admin/onboarding
//   5. Browser GETs /admin/onboarding → requireAdmin runs → calls
//      findTenantForEmail(email) AGAIN
//
// Before the fix: step 2 cached `null` for 30s under the email key. Step 5
// served that stale null, requireAdmin thought "no tenant exists for this
// email", and bounced the brand-new user back to /admin/login.
//
// The fix: never cache null lookups. This test asserts the second call
// hits the DB and returns the new tenant — even if the first call
// happened moments earlier and returned null.

// We mock src/db/client before importing the unit under test so the
// `db()` factory it grabs at module load is the mocked one.
const fromMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: () => ({ from: fromMock }),
}));

import { findTenantForEmail, invalidateTenantCache } from '../../src/tenant/store.js';

function buildQuery(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.is = vi.fn().mockReturnValue(builder);
  builder.order = vi.fn().mockReturnValue(builder);
  builder.limit = vi.fn().mockReturnValue(builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(result);
  return builder;
}

describe('findTenantForEmail cache', () => {
  beforeEach(() => {
    fromMock.mockReset();
    // Empty the cache between tests so prior runs don't pollute. The only
    // public knob is invalidateTenantCache(tenantId), so we invalidate
    // the tenant ids we use in this suite.
    invalidateTenantCache('tenant-from-second-call');
  });

  it('does NOT cache null lookups (regression: new-signup race)', async () => {
    // First call: DB returns no row (email not yet a member of any tenant)
    fromMock.mockReturnValueOnce(buildQuery({ data: null, error: null }));
    const first = await findTenantForEmail('NEW-USER@example.com');
    expect(first).toBeNull();
    expect(fromMock).toHaveBeenCalledTimes(1);

    // Second call (simulating: the OAuth callback just provisioned the
    // tenant + membership, then redirected → requireAdmin re-lookup).
    // If we had cached the null from the first call, the mock would NOT
    // be hit a second time and `second` would also be null. The fix is
    // that we ALWAYS go to the DB for cache-miss-and-null.
    fromMock.mockReturnValueOnce(
      buildQuery({
        data: {
          id: 'membership-1',
          tenant_id: 'tenant-from-second-call',
          email: 'new-user@example.com',
          role: 'owner',
          created_at: '2026-05-26T00:00:00Z',
          last_seen_at: null,
          tenants: {
            id: 'tenant-from-second-call',
            name: 'new-user',
            slug: 'new-user',
            settings: null,
            created_at: '2026-05-26T00:00:00Z',
            created_by_email: 'new-user@example.com',
            onboarding_completed_at: null,
            deleted_at: null,
          },
        },
        error: null,
      }),
    );
    const second = await findTenantForEmail('NEW-USER@example.com');
    expect(second, 'second lookup should find the freshly-provisioned tenant').not.toBeNull();
    expect(second?.tenant.id).toBe('tenant-from-second-call');
    expect(fromMock, 'cache miss on null forces a fresh DB hit').toHaveBeenCalledTimes(2);
  });

  it('DOES cache positive lookups (the optimisation still works)', async () => {
    fromMock.mockReturnValueOnce(
      buildQuery({
        data: {
          id: 'membership-2',
          tenant_id: 'tenant-existing',
          email: 'returning@example.com',
          role: 'owner',
          created_at: '2026-05-25T00:00:00Z',
          last_seen_at: '2026-05-26T12:00:00Z',
          tenants: {
            id: 'tenant-existing',
            name: 'Returning Co',
            slug: 'returning-co',
            settings: null,
            created_at: '2026-05-25T00:00:00Z',
            created_by_email: 'returning@example.com',
            onboarding_completed_at: '2026-05-25T01:00:00Z',
            deleted_at: null,
          },
        },
        error: null,
      }),
    );
    const a = await findTenantForEmail('returning@example.com');
    const b = await findTenantForEmail('returning@example.com');
    expect(a?.tenant.id).toBe('tenant-existing');
    expect(b?.tenant.id).toBe('tenant-existing');
    expect(fromMock, 'second positive lookup served from cache').toHaveBeenCalledTimes(1);
    // Clean up so other tests aren't affected
    invalidateTenantCache('tenant-existing');
  });

  it('lowercases the cache key (so SAME@x.com and same@x.com share)', async () => {
    fromMock.mockReturnValueOnce(
      buildQuery({
        data: {
          id: 'membership-3',
          tenant_id: 'tenant-case',
          email: 'mixed@case.com',
          role: 'owner',
          created_at: '2026-05-25T00:00:00Z',
          last_seen_at: null,
          tenants: {
            id: 'tenant-case',
            name: 'Case',
            slug: 'case',
            settings: null,
            created_at: '2026-05-25T00:00:00Z',
            created_by_email: 'mixed@case.com',
            onboarding_completed_at: null,
            deleted_at: null,
          },
        },
        error: null,
      }),
    );
    const upper = await findTenantForEmail('MIXED@CASE.COM');
    const lower = await findTenantForEmail('mixed@case.com');
    expect(upper?.tenant.id).toBe('tenant-case');
    expect(lower?.tenant.id).toBe('tenant-case');
    expect(fromMock).toHaveBeenCalledTimes(1);
    invalidateTenantCache('tenant-case');
  });
});
