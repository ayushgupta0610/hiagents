import { db } from '../db/client.js';
import { defaultTenantSettings, withDefaults, type TenantSettings } from './types.js';
import { bumpConnectedAt } from '../providers/gmail.js';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  settings: TenantSettings;
  createdAt: string;
  createdByEmail: string | null;
  onboardingCompletedAt: string | null;
  deletedAt: string | null;
}

export interface Membership {
  id: string;
  tenantId: string;
  email: string;
  role: 'owner' | 'admin' | 'viewer';
  createdAt: string;
  lastSeenAt: string | null;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  settings: Partial<TenantSettings> | null;
  created_at: string;
  created_by_email: string | null;
  onboarding_completed_at: string | null;
  deleted_at: string | null;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    settings: withDefaults(row.settings),
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    onboardingCompletedAt: row.onboarding_completed_at,
    deletedAt: row.deleted_at,
  };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tenant'
  );
}

// In-process cache for findTenantForEmail. Every authenticated request
// goes through requireAdmin → findTenantForEmail (a JOIN on memberships +
// tenants), so caching here cuts ~80% of those round-trips during active
// admin use. TTL is short (30s) so role/settings changes propagate quickly;
// settings writes also call invalidateTenantCache() to make changes
// instant for the editing user.
//
// We deliberately do NOT cache null lookups. Two reasons:
//
//   1. First-ever sign-in race: /oauth/callback calls findTenantForEmail()
//      pre-provision (returns null → would cache null), then provisions
//      the tenant, then issues a session cookie, then redirects to
//      /admin/onboarding — which calls findTenantForEmail() AGAIN inside
//      requireAdmin. A stale cached null at step 4 makes requireAdmin
//      bounce the brand-new user back to /admin/login, looking like a
//      silent login failure. (This was the actual root cause of the
//      "test users can't sign in" bug; the regression was introduced
//      when the cache was added — see git log of this file.)
//
//   2. "I just got added to a workspace" race: someone tried to sign in
//      before being added as a member → we cached "no tenant" → admin
//      adds them as a member → for the next 30s their sign-in still
//      bounces because we serve the stale null.
//
// The cost of NOT caching nulls is one DB lookup per unknown-email request.
// memberships.email has a unique index so it's a sub-ms point lookup.
type TenantCacheEntry = {
  value: { tenant: Tenant; membership: Membership };
  expiresAt: number;
};
const TENANT_CACHE_TTL_MS = 30 * 1000;
const tenantCacheByEmail = new Map<string, TenantCacheEntry>();
const emailsByTenantId = new Map<string, Set<string>>();

function cacheKey(email: string): string {
  return email.toLowerCase();
}

function rememberMapping(email: string, tenantId: string): void {
  const set = emailsByTenantId.get(tenantId) ?? new Set<string>();
  set.add(cacheKey(email));
  emailsByTenantId.set(tenantId, set);
}

export function invalidateTenantCache(tenantId: string): void {
  const emails = emailsByTenantId.get(tenantId);
  if (!emails) return;
  for (const e of emails) tenantCacheByEmail.delete(e);
  emailsByTenantId.delete(tenantId);
}

export async function findTenantForEmail(
  email: string,
): Promise<{ tenant: Tenant; membership: Membership } | null> {
  const key = cacheKey(email);
  const cached = tenantCacheByEmail.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const supabase = db();
  const { data, error } = await supabase
    .from('memberships')
    .select('*, tenants!inner(*)')
    .eq('email', key)
    .is('tenants.deleted_at', null)
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`findTenantForEmail: ${error.message}`);

  if (!data) {
    // See the comment block above: NEVER cache nulls.
    return null;
  }

  const tenantRow = (data as { tenants: TenantRow }).tenants;
  const value = {
    tenant: rowToTenant(tenantRow),
    membership: {
      id: data.id,
      tenantId: data.tenant_id,
      email: data.email,
      role: data.role,
      createdAt: data.created_at,
      lastSeenAt: data.last_seen_at,
    },
  };
  tenantCacheByEmail.set(key, { value, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  rememberMapping(key, value.tenant.id);
  return value;
}

export async function provisionTenant(email: string, displayName?: string): Promise<Tenant> {
  const supabase = db();
  const lower = email.toLowerCase();
  const name = displayName?.trim() || lower.split('@')[0] || 'My workspace';

  const base = slugify(name);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data: existing } = await supabase
      .from('tenants')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (!existing) break;
    slug = `${base}-${i}`;
  }

  const { data: tenantRow, error: tErr } = await supabase
    .from('tenants')
    .insert({
      name,
      slug,
      created_by_email: lower,
      settings: defaultTenantSettings(),
    })
    .select()
    .single();
  if (tErr || !tenantRow) throw new Error(`provisionTenant: ${tErr?.message || 'no row'}`);

  const { error: mErr } = await supabase.from('memberships').insert({
    tenant_id: tenantRow.id,
    email: lower,
    role: 'owner',
  });
  if (mErr) throw new Error(`provisionTenant membership: ${mErr.message}`);

  return rowToTenant(tenantRow as TenantRow);
}

export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const { data, error } = await db()
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`getTenant: ${error.message}`);
  return data ? rowToTenant(data as TenantRow) : null;
}

export async function updateSettings(
  tenantId: string,
  patch: Partial<TenantSettings>,
): Promise<TenantSettings> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`updateSettings: tenant ${tenantId} not found`);
  const merged = withDefaults({ ...tenant.settings, ...patch });
  const { error } = await db().from('tenants').update({ settings: merged }).eq('id', tenantId);
  if (error) throw new Error(`updateSettings: ${error.message}`);
  invalidateTenantCache(tenantId);

  // Resuming from a paused state advances the inbox watermark so the bot
  // doesn't catch up on mail that arrived during the pause.
  if (tenant.settings.polling.paused && !merged.polling.paused) {
    await bumpConnectedAt(tenantId);
  }

  return merged;
}

export async function markOnboardingComplete(tenantId: string): Promise<void> {
  const { error } = await db()
    .from('tenants')
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq('id', tenantId)
    .is('onboarding_completed_at', null);
  if (error) throw new Error(`markOnboardingComplete: ${error.message}`);
  invalidateTenantCache(tenantId);
}

export async function softDeleteTenant(tenantId: string): Promise<void> {
  const { error } = await db()
    .from('tenants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', tenantId);
  if (error) throw new Error(`softDeleteTenant: ${error.message}`);
  invalidateTenantCache(tenantId);
}

export async function touchMembership(membershipId: string): Promise<void> {
  await db()
    .from('memberships')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', membershipId);
}

// Slim projection for the poller — the only callers that need the full Tenant
// row are admin/UI paths (which fetch one tenant at a time via getTenant).
// The poller's tick runs every 30-60s and reads N rows, so dropping the
// unused columns (name, slug, created_at, created_by_email, deleted_at) keeps
// per-tick payload small. `settings` is kept because the pipeline reads
// persona/classifier/reply/retrieval/limits per message.
export async function listOnboardedTenants(): Promise<Tenant[]> {
  const { data, error } = await db()
    .from('tenants')
    .select('id, settings')
    .not('onboarding_completed_at', 'is', null)
    .is('deleted_at', null);
  if (error) throw new Error(`listOnboardedTenants: ${error.message}`);
  type SlimRow = { id: string; settings: Partial<TenantSettings> | null };
  return ((data as SlimRow[]) ?? []).map((r) => ({
    id: r.id,
    settings: withDefaults(r.settings),
    // Filled with empty / null so the Tenant shape is preserved for
    // downstream code that types against it. The poller and runPipeline
    // only ever read id + settings.
    name: '',
    slug: '',
    createdAt: '',
    createdByEmail: null,
    onboardingCompletedAt: null,
    deletedAt: null,
  }));
}
