import { db } from '../db/client.js';
import { defaultTenantSettings, withDefaults, type TenantSettings } from './types.js';

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

export async function findTenantForEmail(
  email: string,
): Promise<{ tenant: Tenant; membership: Membership } | null> {
  const supabase = db();
  const { data, error } = await supabase
    .from('memberships')
    .select('*, tenants!inner(*)')
    .eq('email', email.toLowerCase())
    .is('tenants.deleted_at', null)
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`findTenantForEmail: ${error.message}`);
  if (!data) return null;

  const tenantRow = (data as { tenants: TenantRow }).tenants;
  return {
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
  return merged;
}

export async function markOnboardingComplete(tenantId: string): Promise<void> {
  const { error } = await db()
    .from('tenants')
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq('id', tenantId)
    .is('onboarding_completed_at', null);
  if (error) throw new Error(`markOnboardingComplete: ${error.message}`);
}

export async function softDeleteTenant(tenantId: string): Promise<void> {
  const { error } = await db()
    .from('tenants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', tenantId);
  if (error) throw new Error(`softDeleteTenant: ${error.message}`);
}

export async function touchMembership(membershipId: string): Promise<void> {
  await db()
    .from('memberships')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', membershipId);
}

export async function listOnboardedTenants(): Promise<Tenant[]> {
  const { data, error } = await db()
    .from('tenants')
    .select('*')
    .not('onboarding_completed_at', 'is', null)
    .is('deleted_at', null);
  if (error) throw new Error(`listOnboardedTenants: ${error.message}`);
  return ((data as TenantRow[]) ?? []).map(rowToTenant);
}
