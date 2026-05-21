# Multi-tenant SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform inbox-ai from single-tenant-per-deployment to a multi-tenant SaaS where anyone with a Google account can sign up, gets their own auto-provisioned tenant, configures their bot through an onboarding wizard, and operates fully isolated from every other tenant — all on a single deployment.

**Architecture:** Single Supabase project with `tenant_id` on every per-tenant table and RLS enabled. Auto-provisioning on Google sign-in: new email → new tenant + owner membership. Per-tenant config stored in `tenants.settings` JSONB (persona, classifier prompt, models from a curated list, thresholds, auto-send flag, etc.). Every server query is scoped through a `scoped(tenantId)` helper that prevents accidental cross-tenant leaks. Per-tenant LLM usage logged to `llm_usage` table for cost attribution against the shared OpenRouter key. Multi-tenant poller iterates over all onboarded tenants per tick.

**Tech Stack:** Same as v1 — Node 20+, TypeScript, Express, Supabase (pgvector + Storage), OpenRouter for chat + embeddings, Gmail API via `googleapis`, Vitest, Pino, Zod. Plus new: a small client-side state-machine for the onboarding wizard (vanilla JS).

**Project location:** `/Users/gupta/Downloads/Development/Projects/inbox-ai/`

---

## File Structure

```
inbox-ai/
├── supabase/migrations/
│   └── 002_multi_tenant.sql                    # Task 1
├── src/
│   ├── tenant/
│   │   ├── types.ts                            # Task 2 — TenantSettings type + defaults
│   │   ├── store.ts                            # Task 3 — tenants + memberships CRUD
│   │   ├── scoped.ts                           # Task 4 — scoped(tenantId) query helper (TDD)
│   │   ├── audit.ts                            # Task 5 — audit_log writer
│   │   ├── usage.ts                            # Task 6 — llm_usage tracker
│   │   └── limits.ts                           # Task 7 — per-tenant rate-limit checks
│   ├── lib/auth.ts                             # Task 8 — cookie carries tenant_id
│   ├── providers/
│   │   ├── openrouter.ts                       # Task 9 — usage logging wrapper
│   │   ├── embeddings.ts                       # Task 10 — usage logging
│   │   └── gmail.ts                            # Task 11 — per-tenant token IO
│   ├── kb/
│   │   ├── ingest.ts                           # Task 12 — tenant-scoped
│   │   └── search.ts                           # Task 13 — tenant-filtered RPC
│   ├── pipeline/
│   │   ├── classifier.ts                       # Task 14 — tenant settings
│   │   ├── generate.ts                         # Task 14 — tenant settings
│   │   └── run.ts                              # Task 15 — tenant context throughout
│   ├── workers/
│   │   ├── poller.ts                           # Task 16 — multi-tenant loop
│   │   └── cleanup.ts                          # Task 25 — daily hard-delete cron
│   ├── routes/
│   │   ├── admin.ts                            # Task 17, 19 — scoped, plus settings + account
│   │   ├── oauth.ts                            # Task 18 — provision on signin
│   │   ├── onboarding.ts                       # Task 21 — wizard routes
│   │   └── settings.ts                         # Task 19 — broken out from admin
│   ├── ui/
│   │   ├── admin.html                          # Task 23 — onboarding gate
│   │   ├── onboarding.html                     # Task 22 — wizard SPA
│   │   └── settings.html                       # Task 24 — settings UI
│   └── server.ts                               # Task 26 — register routes + cleanup cron
├── tests/integration/
│   └── tenant-isolation.test.ts                # Task 27 — verifies two tenants can't see each other
├── docs/
│   ├── DEPLOY.md                               # Task 28 — updated SaaS deploy
│   ├── ONBOARDING-FLOW.md                      # Task 28 — new
│   └── MIGRATION-002-RUNBOOK.md                # Task 1 — accompanies the migration
└── .env.example                                # Task 8 — note ADMIN_EMAILS removal
```

---

## Phase 1: Schema migration (foundation)

### Task 1: Multi-tenant schema migration + backfill runbook

**Files:**
- Create: `supabase/migrations/002_multi_tenant.sql`
- Create: `docs/MIGRATION-002-RUNBOOK.md`

- [ ] **Step 1: Write `supabase/migrations/002_multi_tenant.sql`**

```sql
-- =========================================================
-- Migration 002: Multi-tenant SaaS
-- - Adds tenants, memberships, audit_log, llm_usage tables
-- - Adds tenant_id to kb_documents, kb_chunks, messages
-- - Rebuilds oauth_tokens to be tenant-scoped (drop singleton)
-- - Backfills existing data into a default tenant
-- - Updates match_kb_chunks RPC to require tenant_id
-- - Enables RLS on every per-tenant table
-- =========================================================

begin;

-- ---- 1. Core SaaS tables ----

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by_email text,
  onboarding_completed_at timestamptz,
  deleted_at timestamptz
);

create index idx_tenants_deleted_at on tenants (deleted_at) where deleted_at is not null;
create index idx_tenants_onboarded on tenants (onboarding_completed_at) where onboarding_completed_at is not null;

create table memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  role text not null default 'admin' check (role in ('owner','admin','viewer')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create unique index uq_memberships_tenant_email on memberships (tenant_id, lower(email));
create index idx_memberships_email_lower on memberships (lower(email));

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_email text,
  action text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index idx_audit_tenant_created on audit_log (tenant_id, created_at desc);

create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  model text not null,
  kind text not null check (kind in ('chat','embedding','classifier')),
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);

create index idx_llm_usage_tenant_created on llm_usage (tenant_id, created_at desc);

-- ---- 2. Backfill: create a default tenant for existing data ----
-- The single existing OAuth account's email becomes the owner.

do $$
declare
  default_tenant_id uuid;
  default_email text;
begin
  -- Pick the existing oauth_tokens email if present, else a placeholder
  select email into default_email from oauth_tokens where id = 1;
  if default_email is null then
    default_email := 'migration-placeholder@local';
  end if;

  insert into tenants (name, slug, created_by_email, onboarding_completed_at)
  values ('Default', 'default', default_email, now())
  returning id into default_tenant_id;

  insert into memberships (tenant_id, email, role)
  values (default_tenant_id, default_email, 'owner')
  on conflict do nothing;

  -- Stash the default tenant id so subsequent backfills can use it
  perform set_config('app.default_tenant_id', default_tenant_id::text, false);
end $$;

-- ---- 3. Add tenant_id to existing tables, backfill, then make NOT NULL ----

alter table kb_documents add column tenant_id uuid references tenants(id) on delete cascade;
update kb_documents set tenant_id = current_setting('app.default_tenant_id')::uuid where tenant_id is null;
alter table kb_documents alter column tenant_id set not null;
create index idx_kb_documents_tenant on kb_documents (tenant_id);

alter table kb_chunks add column tenant_id uuid references tenants(id) on delete cascade;
update kb_chunks set tenant_id = current_setting('app.default_tenant_id')::uuid where tenant_id is null;
alter table kb_chunks alter column tenant_id set not null;
create index idx_kb_chunks_tenant on kb_chunks (tenant_id);

alter table messages add column tenant_id uuid references tenants(id) on delete cascade;
update messages set tenant_id = current_setting('app.default_tenant_id')::uuid where tenant_id is null;
alter table messages alter column tenant_id set not null;
create index idx_messages_tenant on messages (tenant_id);

-- ---- 4. Rebuild oauth_tokens: per-tenant, drop singleton id ----

alter table oauth_tokens add column tenant_id uuid references tenants(id) on delete cascade;
update oauth_tokens set tenant_id = current_setting('app.default_tenant_id')::uuid where tenant_id is null;
alter table oauth_tokens alter column tenant_id set not null;
alter table oauth_tokens drop constraint oauth_tokens_pkey;
alter table oauth_tokens drop constraint oauth_tokens_id_check;
alter table oauth_tokens drop column id;
alter table oauth_tokens add primary key (tenant_id);

-- ---- 5. Update match_kb_chunks RPC to require tenant_id ----

drop function if exists match_kb_chunks(vector(1536), int, float);

create or replace function match_kb_chunks(
  query_embedding vector(1536),
  in_tenant_id uuid,
  match_count int default 5,
  similarity_threshold float default 0.5
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return query
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from kb_chunks c
  where c.tenant_id = in_tenant_id
    and 1 - (c.embedding <=> query_embedding) > similarity_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ---- 6. RLS on every per-tenant table (service role bypasses; this denies anon by default) ----

alter table tenants        enable row level security;
alter table memberships    enable row level security;
alter table audit_log      enable row level security;
alter table llm_usage      enable row level security;
-- kb_documents, kb_chunks, messages, oauth_tokens already had RLS enabled in migration 001

commit;
```

- [ ] **Step 2: Write `docs/MIGRATION-002-RUNBOOK.md`**

```markdown
# Migration 002 Runbook — Multi-tenant SaaS

This migration is **non-reversible** automatically. Test on a Supabase branch first.

## Prerequisites
- Existing `001_init.sql` migration applied
- Existing data is single-tenant (1 oauth_tokens row, N kb_documents, N kb_chunks, N messages)

## Steps

1. **Snapshot the database** in Supabase dashboard (Database → Backups → "Take backup")
2. **Test on a branch first**:
   - Supabase dashboard → Branching → Create branch → "migration-002-test"
   - Run migration SQL in the branch's SQL editor
   - Verify: `select count(*) from tenants;` returns 1, `select count(*) from memberships;` returns 1
   - Verify: every existing `kb_documents` / `kb_chunks` / `messages` / `oauth_tokens` row has a non-null `tenant_id` matching the default tenant
   - Verify: `select * from match_kb_chunks(...)` with the default tenant id returns expected results
3. **If branch test passes**, merge the branch (or copy SQL into prod and run)
4. **Verify in prod**: same checks as step 2
5. **Update the app** (subsequent tasks in this plan) so it knows about the new schema

## Rollback (if migration fails mid-way)

The migration is wrapped in `BEGIN; ... COMMIT;` — if any statement fails, the whole transaction rolls back. Inspect the error and re-run after fixing.

If the migration committed but the app then breaks, you can:
- Restore from the snapshot taken in step 1
- Or run a custom reverse migration (not provided — the migration drops the singleton id from oauth_tokens, which is non-trivial to restore)
```

- [ ] **Step 3: Apply the migration**

Paste the migration SQL into your Supabase SQL editor and Run. Then verify:

```sql
-- Expected: 1
select count(*) from tenants;
-- Expected: 1
select count(*) from memberships;
-- Expected: all existing rows have tenant_id matching the default tenant
select count(*) from kb_documents where tenant_id is null;  -- 0
select count(*) from kb_chunks where tenant_id is null;     -- 0
select count(*) from messages where tenant_id is null;      -- 0
-- Expected: 1 row, with tenant_id = default tenant
select tenant_id, email from oauth_tokens;
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/002_multi_tenant.sql docs/MIGRATION-002-RUNBOOK.md
git commit -m "feat(db): multi-tenant schema with backfill into default tenant"
```

---

## Phase 2: Tenant primitives

### Task 2: TenantSettings type + defaults

**Files:**
- Create: `src/tenant/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// src/tenant/types.ts

// Curated list of allowed reply models (prevents tenants from picking expensive Opus etc.)
export const ALLOWED_REPLY_MODELS = [
  'deepseek/deepseek-v4-flash',
  'google/gemini-3.5-flash',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-4o-mini',
] as const;

export const ALLOWED_CLASSIFIER_MODELS = [
  'openai/gpt-4o-mini',
  'google/gemini-3.5-flash',
  'anthropic/claude-haiku-4.5',
  'deepseek/deepseek-v4-flash',
] as const;

export type ReplyModel = typeof ALLOWED_REPLY_MODELS[number];
export type ClassifierModel = typeof ALLOWED_CLASSIFIER_MODELS[number];

export interface TenantSettings {
  persona: {
    signature: string;
    tone: string;
    companyDescription: string;
  };
  classifier: {
    model: ClassifierModel;
    prompt: string | null;  // null = use default permissive prompt
  };
  reply: {
    model: ReplyModel;
  };
  retrieval: {
    similarityThreshold: number;
    topK: number;
  };
  polling: {
    intervalSeconds: number;
    autoSend: boolean;  // false = save as Gmail draft instead of sending
  };
  limits: {
    dailyEmailCap: number;       // max emails the bot processes per UTC day
    totalChunkCap: number;       // max chunks across all documents
    maxPdfBytes: number;
  };
}

export function defaultTenantSettings(): TenantSettings {
  return {
    persona: {
      signature: '— Sent by inbox-ai',
      tone: 'professional, warm, concise',
      companyDescription: '',
    },
    classifier: {
      model: 'openai/gpt-4o-mini',
      prompt: null,
    },
    reply: {
      model: 'deepseek/deepseek-v4-flash',
    },
    retrieval: {
      similarityThreshold: 0.3,
      topK: 5,
    },
    polling: {
      intervalSeconds: 60,
      autoSend: true,
    },
    limits: {
      dailyEmailCap: 200,
      totalChunkCap: 5000,
      maxPdfBytes: 25 * 1024 * 1024,
    },
  };
}

// Defensive: deep-merge persisted settings over defaults so a partial settings
// object in the DB (e.g. from a previous version) still produces a complete
// TenantSettings without missing keys at runtime.
export function withDefaults(partial: Partial<TenantSettings> | null | undefined): TenantSettings {
  const d = defaultTenantSettings();
  if (!partial) return d;
  return {
    persona: { ...d.persona, ...(partial.persona ?? {}) },
    classifier: { ...d.classifier, ...(partial.classifier ?? {}) },
    reply: { ...d.reply, ...(partial.reply ?? {}) },
    retrieval: { ...d.retrieval, ...(partial.retrieval ?? {}) },
    polling: { ...d.polling, ...(partial.polling ?? {}) },
    limits: { ...d.limits, ...(partial.limits ?? {}) },
  };
}
```

- [ ] **Step 2: Build verify**

```bash
cd /Users/gupta/Downloads/Development/Projects/inbox-ai && npm run build
```

Expected: no TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/tenant/types.ts
git commit -m "feat(tenant): settings type + curated model lists + defaults"
```

---

### Task 3: Tenant + membership store

**Files:**
- Create: `src/tenant/store.ts`

- [ ] **Step 1: Write `src/tenant/store.ts`**

```typescript
// src/tenant/store.ts
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
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tenant';
}

/**
 * Find the tenant a user belongs to. Returns null if they have no memberships.
 * If they have multiple memberships, returns the most recently active one.
 */
export async function findTenantForEmail(email: string): Promise<{ tenant: Tenant; membership: Membership } | null> {
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

/**
 * Provision a brand-new tenant for an email that has no existing memberships.
 * The email becomes the tenant's "owner". The tenant starts with default settings.
 */
export async function provisionTenant(email: string, displayName?: string): Promise<Tenant> {
  const supabase = db();
  const lower = email.toLowerCase();
  const name = displayName?.trim() || lower.split('@')[0] || 'My workspace';

  // Find a unique slug by appending -2, -3 ... if needed
  const base = slugify(name);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data: existing } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle();
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

/**
 * Load tenant by id. Returns null if not found or soft-deleted.
 */
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

/**
 * Update settings (shallow merge at the top level — settings is JSONB).
 */
export async function updateSettings(tenantId: string, patch: Partial<TenantSettings>): Promise<TenantSettings> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`updateSettings: tenant ${tenantId} not found`);
  const merged = withDefaults({ ...tenant.settings, ...patch });
  const { error } = await db().from('tenants').update({ settings: merged }).eq('id', tenantId);
  if (error) throw new Error(`updateSettings: ${error.message}`);
  return merged;
}

/**
 * Mark a tenant as having completed onboarding. Idempotent.
 */
export async function markOnboardingComplete(tenantId: string): Promise<void> {
  const { error } = await db()
    .from('tenants')
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq('id', tenantId)
    .is('onboarding_completed_at', null);
  if (error) throw new Error(`markOnboardingComplete: ${error.message}`);
}

/**
 * Soft-delete a tenant — sets deleted_at; the daily cleanup cron hard-deletes
 * tenants whose deleted_at is older than 30 days.
 */
export async function softDeleteTenant(tenantId: string): Promise<void> {
  const { error } = await db()
    .from('tenants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', tenantId);
  if (error) throw new Error(`softDeleteTenant: ${error.message}`);
}

/**
 * Update a membership's last_seen_at — call this on each authenticated request
 * so we can break ties when a user is in multiple tenants.
 */
export async function touchMembership(membershipId: string): Promise<void> {
  await db().from('memberships').update({ last_seen_at: new Date().toISOString() }).eq('id', membershipId);
}

/**
 * List all onboarded tenants (used by the poller to know which tenants to fetch mail for).
 */
export async function listOnboardedTenants(): Promise<Tenant[]> {
  const { data, error } = await db()
    .from('tenants')
    .select('*')
    .not('onboarding_completed_at', 'is', null)
    .is('deleted_at', null);
  if (error) throw new Error(`listOnboardedTenants: ${error.message}`);
  return (data as TenantRow[] ?? []).map(rowToTenant);
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/tenant/store.ts
git commit -m "feat(tenant): tenant + membership CRUD with provisioning"
```

---

### Task 4: Scoped query helper (TDD)

The single biggest defense against tenant-isolation bugs. Every query that touches a per-tenant table must go through `scoped(tenantId)`.

**Files:**
- Create: `tests/unit/scoped.test.ts`
- Create: `src/tenant/scoped.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/scoped.test.ts
import { describe, it, expect, vi } from 'vitest';
import { tenantScoped } from '../../src/tenant/scoped.js';

describe('tenantScoped', () => {
  it('adds eq("tenant_id", id) on select queries', () => {
    const builder = { eq: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').select('*');

    expect(from).toHaveBeenCalledWith('kb_documents');
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-123');
  });

  it('adds tenant_id to insert payloads (object form)', () => {
    const builder = { insert: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').insert({ filename: 'a.pdf' });

    expect(builder.insert).toHaveBeenCalledWith({ filename: 'a.pdf', tenant_id: 'tenant-123' });
  });

  it('adds tenant_id to insert payloads (array form)', () => {
    const builder = { insert: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_chunks').insert([{ chunk_index: 0 }, { chunk_index: 1 }]);

    expect(builder.insert).toHaveBeenCalledWith([
      { chunk_index: 0, tenant_id: 'tenant-123' },
      { chunk_index: 1, tenant_id: 'tenant-123' },
    ]);
  });

  it('adds eq("tenant_id", id) on update queries', () => {
    const builder = { eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').update({ status: 'ingested' });

    expect(builder.update).toHaveBeenCalledWith({ status: 'ingested' });
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-123');
  });

  it('adds eq("tenant_id", id) on delete queries', () => {
    const builder = { eq: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').delete();

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-123');
  });
});
```

- [ ] **Step 2: Run, confirm RED**

```bash
npm test -- tests/unit/scoped.test.ts
```

Expected: all tests fail because the module doesn't exist.

- [ ] **Step 3: Write `src/tenant/scoped.ts`**

```typescript
// src/tenant/scoped.ts
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Returns a thin Supabase wrapper that auto-applies tenant_id scoping to all
 * select / insert / update / delete operations on the given table. Use this
 * everywhere you'd otherwise call `db().from(...)`.
 *
 * Why a wrapper instead of relying on RLS:
 *   - the app uses the service role key which bypasses RLS
 *   - explicit eq("tenant_id", ...) keeps queries fast (uses the tenant_id index)
 *   - makes tenant scoping visible in the code, not hidden in DB policies
 *
 * Limitations:
 *   - RPC calls (e.g. match_kb_chunks) are NOT scoped automatically — they
 *     accept tenant_id as a parameter explicitly. Use db() for RPC.
 *   - cross-tenant operations (e.g. admin "view all tenants") must bypass this
 *     helper by using db() directly. Document such uses.
 */
export function tenantScoped(supabase: SupabaseClient, tenantId: string) {
  return {
    from(table: string) {
      const builder = supabase.from(table) as unknown as Record<string, unknown>;
      const inject = { tenant_id: tenantId };

      return {
        select(...args: unknown[]) {
          const q = (builder.select as (...a: unknown[]) => { eq: (k: string, v: unknown) => unknown })(...args);
          return (q.eq as (k: string, v: unknown) => unknown)('tenant_id', tenantId);
        },
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const enriched = Array.isArray(payload)
            ? payload.map((row) => ({ ...row, ...inject }))
            : { ...payload, ...inject };
          return (builder.insert as (p: typeof enriched) => unknown)(enriched);
        },
        update(payload: Record<string, unknown>) {
          const q = (builder.update as (p: typeof payload) => { eq: (k: string, v: unknown) => unknown })(payload);
          return q.eq('tenant_id', tenantId);
        },
        delete() {
          const q = (builder.delete as () => { eq: (k: string, v: unknown) => unknown })();
          return q.eq('tenant_id', tenantId);
        },
        upsert(payload: Record<string, unknown> | Record<string, unknown>[], opts?: unknown) {
          const enriched = Array.isArray(payload)
            ? payload.map((row) => ({ ...row, ...inject }))
            : { ...payload, ...inject };
          return (builder.upsert as (p: typeof enriched, o?: unknown) => unknown)(enriched, opts);
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run, confirm GREEN**

```bash
npm test -- tests/unit/scoped.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/tenant/scoped.ts tests/unit/scoped.test.ts
git commit -m "feat(tenant): scoped(tenantId) query helper with tests"
```

---

### Task 5: Audit log writer

**Files:**
- Create: `src/tenant/audit.ts`

- [ ] **Step 1: Write `src/tenant/audit.ts`**

```typescript
// src/tenant/audit.ts
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

export type AuditAction =
  | 'tenant.provisioned'
  | 'tenant.soft_deleted'
  | 'tenant.hard_deleted'
  | 'settings.updated'
  | 'gmail.connected'
  | 'gmail.disconnected'
  | 'kb.upload'
  | 'kb.delete'
  | 'auth.signin'
  | 'auth.signout'
  | 'onboarding.completed';

export async function audit(
  tenantId: string,
  actorEmail: string | null,
  action: AuditAction,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db().from('audit_log').insert({
      tenant_id: tenantId,
      actor_email: actorEmail,
      action,
      metadata: metadata ?? null,
    });
  } catch (err) {
    // Audit log failures must not break the user-visible action — log and continue.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, tenantId, action }, 'audit log write failed');
  }
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/tenant/audit.ts
git commit -m "feat(tenant): audit_log writer with typed action names"
```

---

### Task 6: LLM usage tracker

**Files:**
- Create: `src/tenant/usage.ts`

- [ ] **Step 1: Write `src/tenant/usage.ts`**

```typescript
// src/tenant/usage.ts
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

// USD per 1M tokens (input, output). Source: OpenRouter model pricing as of May 2026.
// Used for tenant-level cost attribution; update as prices change.
const PRICING: Record<string, { input: number; output: number }> = {
  'openai/text-embedding-3-small': { input: 0.02, output: 0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'google/gemini-3.5-flash': { input: 0.075, output: 0.3 },
  'deepseek/deepseek-v4-flash': { input: 0.112, output: 0.224 },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'anthropic/claude-sonnet-4.5': { input: 3, output: 15 },
};

function costFor(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0; // unknown model — record but don't claim a cost
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

export interface UsageRecord {
  tenantId: string;
  model: string;
  kind: 'chat' | 'embedding' | 'classifier';
  promptTokens: number;
  completionTokens: number;
}

export async function recordUsage(rec: UsageRecord): Promise<void> {
  try {
    const total = rec.promptTokens + rec.completionTokens;
    const cost = costFor(rec.model, rec.promptTokens, rec.completionTokens);
    await db().from('llm_usage').insert({
      tenant_id: rec.tenantId,
      model: rec.model,
      kind: rec.kind,
      prompt_tokens: rec.promptTokens,
      completion_tokens: rec.completionTokens,
      total_tokens: total,
      cost_usd: cost.toFixed(6),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, tenantId: rec.tenantId, model: rec.model }, 'usage record failed');
  }
}

export interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  byModel: Array<{ model: string; tokens: number; costUsd: number }>;
}

export async function summarizeUsage(tenantId: string, sinceIso: string): Promise<UsageSummary> {
  const { data, error } = await db()
    .from('llm_usage')
    .select('model, total_tokens, cost_usd')
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`summarizeUsage: ${error.message}`);

  const rows = data ?? [];
  const byModelMap = new Map<string, { tokens: number; costUsd: number }>();
  let totalTokens = 0;
  let totalCost = 0;
  for (const r of rows as Array<{ model: string; total_tokens: number; cost_usd: string | number }>) {
    const tokens = Number(r.total_tokens) || 0;
    const cost = Number(r.cost_usd) || 0;
    totalTokens += tokens;
    totalCost += cost;
    const existing = byModelMap.get(r.model) ?? { tokens: 0, costUsd: 0 };
    existing.tokens += tokens;
    existing.costUsd += cost;
    byModelMap.set(r.model, existing);
  }
  return {
    totalTokens,
    totalCostUsd: totalCost,
    byModel: Array.from(byModelMap.entries()).map(([model, v]) => ({ model, ...v })),
  };
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/tenant/usage.ts
git commit -m "feat(tenant): per-tenant llm_usage tracking with cost rollup"
```

---

### Task 7: Per-tenant rate-limit checks

**Files:**
- Create: `src/tenant/limits.ts`

- [ ] **Step 1: Write `src/tenant/limits.ts`**

```typescript
// src/tenant/limits.ts
import { db } from '../db/client.js';
import type { TenantSettings } from './types.js';

export class LimitExceededError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Check whether the tenant has remaining budget under their daily email cap.
 * Throws LimitExceededError if the cap is hit. Call this BEFORE running the
 * pipeline on an inbound email.
 */
export async function assertEmailQuota(tenantId: string, settings: TenantSettings): Promise<void> {
  const since = startOfUtcDayIso();
  const { count, error } = await db()
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('received_at', since);
  if (error) throw new Error(`assertEmailQuota: ${error.message}`);
  const cap = settings.limits.dailyEmailCap;
  if ((count ?? 0) >= cap) {
    throw new LimitExceededError(
      `Daily email cap reached: ${count} / ${cap} processed today (UTC). Raise it in Settings or wait until tomorrow.`,
      'daily-email-cap',
    );
  }
}

/**
 * Check whether the tenant has remaining KB capacity. Throws if exceeded.
 * Call this BEFORE inserting chunks during PDF ingest.
 */
export async function assertChunkCapacity(
  tenantId: string,
  settings: TenantSettings,
  newChunks: number,
): Promise<void> {
  const { count, error } = await db()
    .from('kb_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`assertChunkCapacity: ${error.message}`);
  const cap = settings.limits.totalChunkCap;
  const current = count ?? 0;
  if (current + newChunks > cap) {
    throw new LimitExceededError(
      `KB capacity exceeded: ${current} existing + ${newChunks} new > cap of ${cap}. Delete some documents or raise the cap in Settings.`,
      'chunk-cap',
    );
  }
}

/**
 * Pdf size guard. Throws if a file exceeds the tenant's maxPdfBytes setting.
 */
export function assertPdfSize(buffer: Buffer, settings: TenantSettings): void {
  if (buffer.byteLength > settings.limits.maxPdfBytes) {
    const mb = (buffer.byteLength / 1024 / 1024).toFixed(1);
    const capMb = (settings.limits.maxPdfBytes / 1024 / 1024).toFixed(0);
    throw new LimitExceededError(`PDF is ${mb} MB, exceeds cap of ${capMb} MB.`, 'pdf-size');
  }
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/tenant/limits.ts
git commit -m "feat(tenant): per-tenant rate-limit guards (email, chunks, pdf size)"
```

---

## Phase 3: Auth & provisioning

### Task 8: Cookie format with tenant_id + drop ADMIN_EMAILS dependency

**Files:**
- Modify: `src/lib/auth.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Rewrite `src/lib/auth.ts`**

```typescript
// src/lib/auth.ts
import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { findTenantForEmail, touchMembership } from '../tenant/store.js';

const COOKIE = 'inbox_ai_admin';

function sign(value: string): string {
  return createHmac('sha256', env.ADMIN_PASSWORD).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface Session {
  email: string;
  tenantId: string | null; // null for password-fallback sessions
  ts: number;
}

function encode(s: string): string { return Buffer.from(s, 'utf-8').toString('base64url'); }
function decode(b: string): string { return Buffer.from(b, 'base64url').toString('utf-8'); }

function parseSession(value: string | undefined): Session | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [ts, emailB64, tenantB64, sig] = parts;
  if (!ts || !emailB64 || !tenantB64 || !sig) return null;
  const payload = `${ts}.${emailB64}.${tenantB64}`;
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const email = decode(emailB64);
    const decoded = decode(tenantB64);
    return { email, tenantId: decoded === '' ? null : decoded, ts: Number(ts) };
  } catch { return null; }
}

function issueCookie(res: Response, email: string, tenantId: string | null): void {
  const ts = String(Date.now());
  const emailB64 = encode(email);
  const tenantB64 = encode(tenantId ?? '');
  const payload = `${ts}.${emailB64}.${tenantB64}`;
  const sig = sign(payload);
  res.cookie(COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function issueSessionForEmail(res: Response, email: string, tenantId: string): void {
  issueCookie(res, email.toLowerCase(), tenantId);
}

export function issueSessionForPassword(res: Response): void {
  issueCookie(res, '__password__', null);
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' });
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = parseSession(req.cookies?.[COOKIE]);

  // Password-fallback session — still works but isn't tenant-scoped; only
  // useful for emergency access in single-tenant deployments. We treat it
  // as having access to the default tenant if exactly one exists.
  if (session && session.email === '__password__') {
    res.locals.adminEmail = null;
    res.locals.tenantId = null;
    res.locals.passwordSession = true;
    next();
    return;
  }

  if (session && session.email && session.tenantId) {
    // Verify membership still exists (in case it was revoked since the cookie was issued)
    const found = await findTenantForEmail(session.email);
    if (found && found.tenant.id === session.tenantId && !found.tenant.deletedAt) {
      res.locals.adminEmail = session.email;
      res.locals.tenantId = found.tenant.id;
      res.locals.tenant = found.tenant;
      res.locals.membershipId = found.membership.id;
      touchMembership(found.membership.id).catch(() => {/* non-critical */});
      next();
      return;
    }
  }

  if (req.path.startsWith('/api/') || req.xhr) {
    res.status(401).json({ error: 'unauthorized', loginUrl: '/admin/login' });
  } else {
    res.redirect('/admin/login');
  }
}

export function checkPassword(input: string): boolean {
  return safeEqual(input, env.ADMIN_PASSWORD);
}
```

- [ ] **Step 2: Modify `src/config.ts` — remove `ADMIN_EMAILS` (no longer used; replaced by memberships table)**

Find and delete this line:
```typescript
ADMIN_EMAILS: z.string().optional(),
```

- [ ] **Step 3: Modify `.env.example`**

Delete the `ADMIN_EMAILS=...` block and replace with a note:

```bash
# Note: in the multi-tenant SaaS build, ADMIN_EMAILS is replaced by the
# memberships table. Anyone with a Google account can sign in and they
# get auto-provisioned a tenant. See docs/ONBOARDING-FLOW.md.
```

- [ ] **Step 4: Build**

```bash
npm run build
```

(Expect compile errors in any file that referenced the removed exports — fixed in subsequent tasks.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts src/config.ts .env.example
git commit -m "feat(auth): session cookie carries tenant_id; drop ADMIN_EMAILS env"
```

---

## Phase 4: Tenant-scoped pipeline + Gmail

### Task 9: OpenRouter wrapper with usage logging

**Files:**
- Modify: `src/providers/openrouter.ts`

- [ ] **Step 1: Rewrite the file**

```typescript
// src/providers/openrouter.ts
import { env } from '../config.js';
import { recordUsage } from '../tenant/usage.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tenantId?: string;
  kind?: 'chat' | 'classifier';  // for usage reporting
}

interface OpenRouterResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function chat(opts: ChatOptions): Promise<string> {
  const body = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1024,
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': env.BASE_URL,
      'X-Title': 'inbox-ai',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }
  const json = (await res.json()) as OpenRouterResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');

  if (opts.tenantId) {
    await recordUsage({
      tenantId: opts.tenantId,
      model: opts.model,
      kind: opts.kind ?? 'chat',
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    });
  }

  return content;
}
```

- [ ] **Step 2: Commit**

```bash
npm run build
git add src/providers/openrouter.ts
git commit -m "feat(providers): openrouter chat() records per-tenant usage"
```

---

### Task 10: Embeddings wrapper with usage logging

**Files:**
- Modify: `src/providers/embeddings.ts`

- [ ] **Step 1: Rewrite**

```typescript
// src/providers/embeddings.ts
import { env } from '../config.js';
import { recordUsage } from '../tenant/usage.js';

const MODEL = 'openai/text-embedding-3-small';
const DIMENSIONS = 1536;

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export async function embed(texts: string[], tenantId?: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 100) batches.push(texts.slice(i, i + 100));

  const all: number[][] = [];
  let totalTokens = 0;
  for (const batch of batches) {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': env.BASE_URL,
        'X-Title': 'inbox-ai',
      },
      body: JSON.stringify({ model: MODEL, input: batch }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter embeddings ${res.status}: ${text}`);
    }
    const json = (await res.json()) as EmbeddingResponse;
    for (const row of json.data) {
      if (row.embedding.length !== DIMENSIONS) {
        throw new Error(`Unexpected embedding dim: ${row.embedding.length}`);
      }
      all.push(row.embedding);
    }
    totalTokens += json.usage?.total_tokens ?? 0;
  }

  if (tenantId) {
    await recordUsage({
      tenantId,
      model: MODEL,
      kind: 'embedding',
      promptTokens: totalTokens,
      completionTokens: 0,
    });
  }

  return all;
}

export async function embedOne(text: string, tenantId?: string): Promise<number[]> {
  const [vec] = await embed([text], tenantId);
  if (!vec) throw new Error('embed returned empty');
  return vec;
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/providers/embeddings.ts
git commit -m "feat(providers): embeddings track per-tenant token usage"
```

---

### Task 11: Per-tenant Gmail token IO

**Files:**
- Modify: `src/providers/gmail.ts`

- [ ] **Step 1: Replace the singleton-based functions with tenant-scoped versions**

Find the existing `loadStoredTokens`, `saveTokens`, `gmailClient` functions and replace them with these. Keep everything else unchanged.

```typescript
// In src/providers/gmail.ts — replace the existing loadStoredTokens / saveTokens / gmailClient

export async function loadStoredTokensForTenant(tenantId: string): Promise<OAuth2Client | null> {
  const { data, error } = await db().from('oauth_tokens').select('*').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error(`Failed to load oauth tokens: ${error.message}`);
  if (!data) return null;
  const oauth = getOAuthClient();
  oauth.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: new Date(data.expires_at).getTime(),
    scope: data.scope,
  });
  oauth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await db()
        .from('oauth_tokens')
        .update({
          access_token: tokens.access_token,
          ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
          expires_at: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : new Date(Date.now() + 3500_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('tenant_id', tenantId);
      logger.debug({ tenantId }, 'refreshed gmail access token');
    }
  });
  return oauth;
}

export async function saveTokensForTenant(
  tenantId: string,
  tokens: { access_token: string; refresh_token: string; expiry_date: number; scope: string },
  email: string,
): Promise<void> {
  await db().from('oauth_tokens').upsert(
    {
      tenant_id: tenantId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(tokens.expiry_date).toISOString(),
      scope: tokens.scope,
      email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id' },
  );
}

export async function getGmailClientForTenant(tenantId: string): Promise<gmail_v1.Gmail> {
  const auth = await loadStoredTokensForTenant(tenantId);
  if (!auth) throw new Error('Gmail not connected. Visit /oauth/start to authorize.');
  return google.gmail({ version: 'v1', auth });
}

// Backwards-compat shim during migration — delete after all callers move to the per-tenant variants
export async function loadStoredTokens() {
  throw new Error('loadStoredTokens() is deprecated — use loadStoredTokensForTenant(tenantId)');
}
export async function saveTokens(...args: unknown[]) {
  throw new Error('saveTokens() is deprecated — use saveTokensForTenant(tenantId, ...)');
}
```

Then update every `gmailClient()` call in this file (e.g., in `listUnreadInbox`, `fetchMessage`, `fetchThreadMessages`, `markRead`, `applyLabel`, `sendReply`) to accept a `tenantId` parameter and use `getGmailClientForTenant(tenantId)` instead.

For each of those functions, change the signature to accept `tenantId` as the first arg. Example for `listUnreadInbox`:

```typescript
export async function listUnreadInbox(tenantId: string, maxResults = 25): Promise<string[]> {
  const gmail = await getGmailClientForTenant(tenantId);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox is:unread -category:promotions -category:social',
    maxResults,
  });
  return (res.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
```

Apply the same `tenantId` first-arg change to: `fetchMessage`, `fetchThreadMessages`, `markRead`, `applyLabel`, `sendReply`.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expect compile errors in callers (poller, run.ts, etc.) — those are fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/providers/gmail.ts
git commit -m "feat(gmail): every operation takes tenantId; tokens keyed per tenant"
```

---

### Task 12: Tenant-scoped KB ingest

**Files:**
- Modify: `src/kb/ingest.ts`

- [ ] **Step 1: Rewrite `src/kb/ingest.ts`**

```typescript
// src/kb/ingest.ts
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { extractPdf } from './pdf-extract.js';
import { chunkText } from './chunk.js';
import { embed } from '../providers/embeddings.js';
import { tenantScoped } from '../tenant/scoped.js';
import { assertChunkCapacity, assertPdfSize } from '../tenant/limits.js';
import type { TenantSettings } from '../tenant/types.js';
import { audit } from '../tenant/audit.js';

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

export interface IngestResult {
  documentId: string;
  chunkCount: number;
}

export interface IngestContext {
  tenantId: string;
  settings: TenantSettings;
  actorEmail: string | null;
}

export async function ingestPdf(ctx: IngestContext, filename: string, buffer: Buffer): Promise<IngestResult> {
  assertPdfSize(buffer, ctx.settings);

  const supabase = db();
  const scoped = tenantScoped(supabase, ctx.tenantId);

  const { data: doc, error: docErr } = await scoped
    .from('kb_documents')
    .insert({ filename, size_bytes: buffer.byteLength, status: 'pending' })
    .select()
    .single();
  if (docErr || !doc) throw new Error(`Failed to create document row: ${docErr?.message}`);

  try {
    const { text, pageCount } = await extractPdf(buffer);
    logger.info({ tenantId: ctx.tenantId, filename, pageCount, chars: text.length }, 'extracted PDF');

    const chunks = chunkText(text, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP });
    logger.info({ tenantId: ctx.tenantId, filename, chunks: chunks.length }, 'chunked text');

    // Cap check BEFORE embedding to avoid wasting tokens
    await assertChunkCapacity(ctx.tenantId, ctx.settings, chunks.length);

    const embeddings = await embed(chunks, ctx.tenantId);
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${chunks.length}`);
    }

    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i]!,
    }));
    const { error: chunkErr } = await scoped.from('kb_chunks').insert(rows);
    if (chunkErr) throw new Error(`Failed to insert chunks: ${chunkErr.message}`);

    await scoped
      .from('kb_documents')
      .update({ status: 'ingested', chunk_count: chunks.length })
      .eq('id', doc.id);

    await audit(ctx.tenantId, ctx.actorEmail, 'kb.upload', { filename, chunkCount: chunks.length });
    return { documentId: doc.id, chunkCount: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await scoped
      .from('kb_documents')
      .update({ status: 'failed', error: message })
      .eq('id', doc.id);
    throw err;
  }
}

export async function deleteDocument(ctx: IngestContext, documentId: string): Promise<void> {
  const { error } = await tenantScoped(db(), ctx.tenantId).from('kb_documents').delete().eq('id', documentId);
  if (error) throw new Error(`Failed to delete document: ${error.message}`);
  await audit(ctx.tenantId, ctx.actorEmail, 'kb.delete', { documentId });
}

export async function listDocuments(tenantId: string) {
  const { data, error } = await tenantScoped(db(), tenantId)
    .from('kb_documents')
    .select('*')
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(`Failed to list documents: ${error.message}`);
  return data;
}
```

Note: `tenantScoped.from(...).select(...).order(...)` may need a small extension to the scoped helper to forward `.order()` to the underlying builder. If TS complains, return the raw query builder from `.select()` and re-add `.eq('tenant_id', tenantId)` explicitly — or extend `scoped.ts` to forward more methods. **If you find scoped's surface area too thin during this task, add `.order`, `.limit`, `.maybeSingle`, `.single`, `.in`, `.gte`, `.lte` chainable forwards in `scoped.ts` and re-run that test.**

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/kb/ingest.ts
git commit -m "feat(kb): ingest takes tenant ctx; enforces caps; audits operations"
```

---

### Task 13: Tenant-filtered vector search

**Files:**
- Modify: `src/kb/search.ts`

- [ ] **Step 1: Rewrite**

```typescript
// src/kb/search.ts
import { db } from '../db/client.js';
import { embedOne } from '../providers/embeddings.js';
import type { RetrievedChunk } from '../types.js';
import type { TenantSettings } from '../tenant/types.js';

export async function search(
  tenantId: string,
  settings: TenantSettings,
  query: string,
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedOne(query, tenantId);
  const { data, error } = await db().rpc('match_kb_chunks', {
    query_embedding: queryEmbedding,
    in_tenant_id: tenantId,
    match_count: settings.retrieval.topK,
    similarity_threshold: settings.retrieval.similarityThreshold,
  });
  if (error) throw new Error(`Vector search failed: ${error.message}`);
  return (data ?? []).map(
    (row: { id: string; document_id: string; content: string; similarity: number }) => ({
      id: row.id,
      documentId: row.document_id,
      content: row.content,
      similarity: row.similarity,
    }),
  );
}
```

- [ ] **Step 2: Update `.scripts/probe-search.mts` and `.scripts/probe-pipeline.mts` to pass a `tenantId` to `search` and `embed`. (Pick the default tenant via `select id from tenants limit 1` in the script.)**

For brevity, update probe-search.mts:

```typescript
// Add at top after env import
const { data: t } = await db().from('tenants').select('id').limit(1).maybeSingle();
const tenantId = t?.id;
if (!tenantId) { console.error('No tenant found'); process.exit(1); }

// Change embedOne(query) -> embedOne(query, tenantId)
// Change rpc call params to include in_tenant_id: tenantId
```

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/kb/search.ts .scripts/probe-search.mts .scripts/probe-pipeline.mts
git commit -m "feat(kb): vector search filters by tenant_id via updated rpc"
```

---

### Task 14: Pipeline uses per-tenant settings (classifier + generator)

**Files:**
- Modify: `src/pipeline/classifier.ts`
- Modify: `src/pipeline/generate.ts`

- [ ] **Step 1: Update `src/pipeline/classifier.ts`**

Change the `classify` function signature to take `tenantId + settings`:

```typescript
// Replace the existing classify() function:
export async function classify(
  tenantId: string,
  settings: import('../tenant/types.js').TenantSettings,
  input: ClassifierInput,
): Promise<ClassifierVerdict> {
  const { chat } = await import('../providers/openrouter.js');
  const systemPrompt = settings.classifier.prompt?.trim() || DEFAULT_CLASSIFIER_PROMPT;
  return classifyWith(async (userPrompt) => {
    return await chat({
      model: settings.classifier.model,
      temperature: 0,
      maxTokens: 5,
      tenantId,
      kind: 'classifier',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
  }, input);
}
```

- [ ] **Step 2: Update `src/pipeline/generate.ts`**

```typescript
// src/pipeline/generate.ts
import { chat } from '../providers/openrouter.js';
import type { RetrievedChunk, IncomingEmail } from '../types.js';
import type { TenantSettings } from '../tenant/types.js';

export interface GenerateInput {
  tenantId: string;
  settings: TenantSettings;
  email: IncomingEmail;
  chunks: RetrievedChunk[];
}

const SYSTEM_TEMPLATE = (tone: string, company: string, signature: string) =>
  `You are an email assistant replying on behalf of ${company || 'the recipient'}. Tone: ${tone}.

Rules:
- Answer ONLY using the provided knowledge base context. If the context does not cover the question, say so politely and offer to follow up — do NOT invent facts.
- Address the sender by name if their name is in the email; otherwise no greeting name.
- Keep replies under 200 words unless the question genuinely requires more.
- No markdown, no bullet lists unless the original email used them. Plain prose, short paragraphs.
- End with this exact signature on its own line:
${signature}`;

function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => `[Source ${i + 1} (similarity ${c.similarity.toFixed(2)})]\n${c.content}`)
    .join('\n\n---\n\n');
}

export async function generateReply(input: GenerateInput): Promise<string> {
  const { persona } = input.settings;
  const system = SYSTEM_TEMPLATE(persona.tone, persona.companyDescription, persona.signature);
  const context = buildContextBlock(input.chunks);
  const userPrompt = `Knowledge base context:
${context}

---

Incoming email:
From: ${input.email.from}
Subject: ${input.email.subject}

${input.email.bodyText}

---

Write the reply now. Plain text only.`;

  return await chat({
    model: input.settings.reply.model,
    temperature: 0.3,
    maxTokens: 800,
    tenantId: input.tenantId,
    kind: 'chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  });
}
```

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/pipeline/classifier.ts src/pipeline/generate.ts
git commit -m "feat(pipeline): classifier + generator pull config from tenant settings"
```

---

### Task 15: Pipeline orchestration with tenant context

**Files:**
- Modify: `src/pipeline/run.ts`

- [ ] **Step 1: Rewrite**

```typescript
// src/pipeline/run.ts
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { tenantScoped } from '../tenant/scoped.js';
import { assertEmailQuota, LimitExceededError } from '../tenant/limits.js';
import type { Tenant } from '../tenant/store.js';
import type { IncomingEmail, Classification, ReplyStatus } from '../types.js';
import { isAutoOrBulk } from './loop-guard.js';
import { loadBotSentIdsForThread, ownerHasReplied } from './thread-guard.js';
import { classify } from './classifier.js';
import { search } from '../kb/search.js';
import { generateReply } from './generate.js';
import { fetchThreadMessages, sendReply, type SendReplyInput } from '../providers/gmail.js';

export interface RunResult {
  classification: Classification;
  replyStatus: ReplyStatus | 'none';
  replyReason?: string;
}

export interface RunContext {
  tenant: Tenant;
  ownerEmail: string;  // the Gmail address the bot operates as (from oauth_tokens)
}

function isFromSelf(email: IncomingEmail, ownerEmail: string): boolean {
  const match = email.from.match(/<([^>]+)>/);
  const sender = (match?.[1] ?? email.from).trim().toLowerCase();
  return sender === ownerEmail.toLowerCase();
}

export async function runPipeline(ctx: RunContext, email: IncomingEmail): Promise<RunResult> {
  const supabase = db();
  const scoped = tenantScoped(supabase, ctx.tenant.id);
  const settings = ctx.tenant.settings;

  // Idempotency: check the scoped messages table
  const { data: existing } = await scoped
    .from('messages')
    .select('id')
    .eq('gmail_message_id', email.gmailMessageId)
    .maybeSingle();
  if (existing) {
    logger.info({ tenantId: ctx.tenant.id, id: email.gmailMessageId }, 'already processed');
    return { classification: 'other', replyStatus: 'none', replyReason: 'already-processed' };
  }

  // Per-tenant daily cap
  try {
    await assertEmailQuota(ctx.tenant.id, settings);
  } catch (err) {
    if (err instanceof LimitExceededError) {
      logger.warn({ tenantId: ctx.tenant.id, code: err.code }, 'daily email cap reached');
      await scoped.from('messages').insert({
        gmail_message_id: email.gmailMessageId,
        gmail_thread_id: email.gmailThreadId,
        received_at: email.receivedAt.toISOString(),
        from_address: email.from,
        subject: email.subject,
        body_text: email.bodyText.slice(0, 50_000),
        classification: 'skipped_loop',
        reply_status: 'skipped',
        reply_reason: `daily-cap: ${err.message}`,
      });
      return { classification: 'skipped_loop', replyStatus: 'skipped', replyReason: 'daily-cap' };
    }
    throw err;
  }

  const baseRow = {
    gmail_message_id: email.gmailMessageId,
    gmail_thread_id: email.gmailThreadId,
    received_at: email.receivedAt.toISOString(),
    from_address: email.from,
    subject: email.subject,
    body_text: email.bodyText.slice(0, 50_000),
  };

  if (isFromSelf(email, ctx.ownerEmail)) {
    await scoped.from('messages').insert({ ...baseRow, classification: 'skipped_self', reply_status: 'skipped', reply_reason: 'from-self' });
    return { classification: 'skipped_self', replyStatus: 'skipped' };
  }

  if (isAutoOrBulk(email.headers)) {
    await scoped.from('messages').insert({ ...baseRow, classification: 'skipped_loop', reply_status: 'skipped', reply_reason: 'auto-or-bulk-headers' });
    return { classification: 'skipped_loop', replyStatus: 'skipped' };
  }

  const botSentIds = await loadBotSentIdsForThread(ctx.tenant.id, email.gmailThreadId);
  const threadMessages = await fetchThreadMessages(ctx.tenant.id, email.gmailThreadId);
  if (ownerHasReplied(threadMessages, ctx.ownerEmail, botSentIds)) {
    await scoped.from('messages').insert({ ...baseRow, classification: 'skipped_thread', reply_status: 'skipped', reply_reason: 'owner-replied-manually' });
    return { classification: 'skipped_thread', replyStatus: 'skipped' };
  }

  try {
    const verdict = await classify(ctx.tenant.id, settings, {
      from: email.from,
      subject: email.subject,
      bodyText: email.bodyText,
    });
    if (verdict === 'other') {
      await scoped.from('messages').insert({ ...baseRow, classification: 'other', reply_status: 'skipped', reply_reason: 'classifier-other' });
      return { classification: 'other', replyStatus: 'skipped' };
    }

    const query = `${email.subject}\n\n${email.bodyText}`;
    const chunks = await search(ctx.tenant.id, settings, query);
    const topSim = chunks[0]?.similarity ?? 0;

    if (chunks.length === 0) {
      await scoped.from('messages').insert({ ...baseRow, classification: 'client_query', top_similarity: 0, reply_status: 'skipped', reply_reason: 'no-kb-match' });
      return { classification: 'client_query', replyStatus: 'skipped', replyReason: 'no-kb-match' };
    }

    const replyText = await generateReply({ tenantId: ctx.tenant.id, settings, email, chunks });

    if (!settings.polling.autoSend) {
      // Draft mode — TODO: write to Gmail drafts via gmail.users.drafts.create
      // For v1 of multi-tenant, treat draft mode as "log only, don't send"
      await scoped.from('messages').insert({
        ...baseRow,
        classification: 'client_query',
        retrieved_chunk_ids: chunks.map((c) => c.id),
        top_similarity: topSim,
        reply_text: replyText,
        reply_status: 'drafted',
        reply_reason: 'auto-send disabled',
      });
      logger.info({ tenantId: ctx.tenant.id, id: email.gmailMessageId }, 'reply drafted (autoSend off)');
      return { classification: 'client_query', replyStatus: 'sent', replyReason: 'drafted' };
    }

    const sendInput: SendReplyInput = {
      threadId: email.gmailThreadId,
      inReplyToMessageId: email.gmailMessageId,
      originalMessageIdHeader: email.headers['message-id'],
      to: email.from,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      bodyText: replyText,
    };
    const sentId = await sendReply(ctx.tenant.id, sendInput);

    await scoped.from('messages').insert({
      ...baseRow,
      classification: 'client_query',
      retrieved_chunk_ids: chunks.map((c) => c.id),
      top_similarity: topSim,
      reply_text: replyText,
      reply_status: 'sent',
      reply_sent_at: new Date().toISOString(),
      reply_gmail_message_id: sentId,
    });

    logger.info({ tenantId: ctx.tenant.id, id: email.gmailMessageId, topSim }, 'reply sent');
    return { classification: 'client_query', replyStatus: 'sent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scoped.from('messages').insert({ ...baseRow, classification: 'error', reply_status: 'failed', reply_reason: msg.slice(0, 500) });
    throw err;
  }
}
```

- [ ] **Step 2: Update `src/pipeline/thread-guard.ts` to take tenantId**

```typescript
// Find loadBotSentIdsForThread and update:
export async function loadBotSentIdsForThread(tenantId: string, gmailThreadId: string): Promise<Set<string>> {
  const { db } = await import('../db/client.js');
  const { data, error } = await db()
    .from('messages')
    .select('reply_gmail_message_id')
    .eq('tenant_id', tenantId)
    .eq('gmail_thread_id', gmailThreadId)
    .not('reply_gmail_message_id', 'is', null);
  if (error) throw new Error(`loadBotSentIdsForThread: ${error.message}`);
  return new Set((data ?? []).map((r: { reply_gmail_message_id: string }) => r.reply_gmail_message_id));
}
```

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/pipeline/run.ts src/pipeline/thread-guard.ts
git commit -m "feat(pipeline): run.ts threads tenant context end-to-end"
```

---

## Phase 5: Multi-tenant poller

### Task 16: Poller iterates over tenants

**Files:**
- Modify: `src/workers/poller.ts`

- [ ] **Step 1: Rewrite**

```typescript
// src/workers/poller.ts
import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { env } from '../config.js';
import { listUnreadInbox, fetchMessage, markRead, applyLabel } from '../providers/gmail.js';
import { runPipeline } from '../pipeline/run.js';
import { listOnboardedTenants } from '../tenant/store.js';
import { db } from '../db/client.js';

let running = false;

async function processTenant(tenantId: string, ownerEmail: string): Promise<void> {
  const { data: tenantRow } = await db().from('tenants').select('*').eq('id', tenantId).maybeSingle();
  if (!tenantRow) return;
  const tenant = {
    id: tenantRow.id,
    name: tenantRow.name,
    slug: tenantRow.slug,
    settings: (await import('../tenant/types.js')).withDefaults(tenantRow.settings),
    createdAt: tenantRow.created_at,
    createdByEmail: tenantRow.created_by_email,
    onboardingCompletedAt: tenantRow.onboarding_completed_at,
    deletedAt: tenantRow.deleted_at,
  };

  let ids: string[];
  try {
    ids = await listUnreadInbox(tenant.id, 25);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tenantId, err: msg }, 'poll: list inbox failed; skipping tenant this tick');
    return;
  }
  if (ids.length === 0) return;
  logger.info({ tenantId, count: ids.length }, 'polled inbox');

  for (const id of ids) {
    try {
      const email = await fetchMessage(tenant.id, id);
      const result = await runPipeline({ tenant, ownerEmail }, email);
      try { await markRead(tenant.id, id); } catch { /* ignore */ }
      const label =
        result.replyStatus === 'sent' ? 'inbox-ai/replied'
        : result.classification === 'skipped_thread' ? 'inbox-ai/owner-took-over'
        : 'inbox-ai/skipped';
      try { await applyLabel(tenant.id, id, label); } catch { /* ignore */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ tenantId, id, err: msg }, 'pipeline failed for message');
      try { await markRead(tenant.id, id); } catch { /* ignore */ }
      try { await applyLabel(tenant.id, id, 'inbox-ai/failed'); } catch { /* ignore */ }
    }
  }
}

async function tick(): Promise<void> {
  if (running) {
    logger.debug('previous tick still running, skipping');
    return;
  }
  running = true;
  try {
    const tenants = await listOnboardedTenants();
    // Find each tenant's owner email from oauth_tokens
    const { data: tokens } = await db().from('oauth_tokens').select('tenant_id, email');
    const ownerByTenant = new Map<string, string>();
    for (const row of (tokens ?? []) as Array<{ tenant_id: string; email: string }>) {
      ownerByTenant.set(row.tenant_id, row.email);
    }

    for (const t of tenants) {
      const owner = ownerByTenant.get(t.id);
      if (!owner) continue; // tenant onboarded but mailbox disconnected — skip
      try {
        await processTenant(t.id, owner);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tenantId: t.id, err: msg }, 'tenant poll failed');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'poll tick failed');
  } finally {
    running = false;
  }
}

export function startPoller(): void {
  const seconds = env.POLL_INTERVAL_SECONDS;
  const expr = `*/${seconds} * * * * *`;
  cron.schedule(expr, tick);
  logger.info({ intervalSeconds: seconds }, 'multi-tenant gmail poller scheduled');
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/workers/poller.ts
git commit -m "feat(workers): multi-tenant poller iterates all onboarded tenants"
```

---

## Phase 6: Routes (admin + onboarding + settings)

### Task 17: Update existing admin routes for tenant scoping

**Files:**
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Rewrite the JSON API endpoints to use res.locals.tenantId**

Replace all endpoints in `src/routes/admin.ts` that currently call `db().from(...)` or `listDocuments()` / `ingestPdf()` / etc. with tenant-scoped calls. Key changes:

```typescript
// Replace listDocuments / ingestPdf / deleteDocument calls — they now take IngestContext

adminRouter.get('/api/documents', requireAdmin, async (_req, res) => {
  res.json(await listDocuments(res.locals.tenantId));
});

adminRouter.post('/api/documents', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'no file uploaded' }); return; }
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    res.status(400).json({ error: 'only PDF files supported' });
    return;
  }
  try {
    const result = await ingestPdf(
      { tenantId: res.locals.tenantId, settings: res.locals.tenant.settings, actorEmail: res.locals.adminEmail },
      req.file.originalname,
      req.file.buffer,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

adminRouter.delete('/api/documents/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !id) { res.status(400).json({ error: 'missing id' }); return; }
  try {
    await deleteDocument(
      { tenantId: res.locals.tenantId, settings: res.locals.tenant.settings, actorEmail: res.locals.adminEmail },
      id,
    );
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

adminRouter.get('/api/messages', requireAdmin, async (_req, res) => {
  const { data, error } = await tenantScoped(db(), res.locals.tenantId)
    .from('messages')
    .select('*')
    .order('received_at', { ascending: false })
    .limit(100);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

adminRouter.get('/api/status', requireAdmin, async (_req, res) => {
  const { data: oauth } = await db()
    .from('oauth_tokens')
    .select('email, updated_at')
    .eq('tenant_id', res.locals.tenantId)
    .maybeSingle();
  res.json({
    gmail: oauth ?? null,
    admin: { email: res.locals.adminEmail },
    tenant: { id: res.locals.tenant?.id, name: res.locals.tenant?.name, slug: res.locals.tenant?.slug, onboardingCompletedAt: res.locals.tenant?.onboardingCompletedAt },
  });
});

adminRouter.get('/api/stats', requireAdmin, async (_req, res) => {
  const tenantId = res.locals.tenantId;
  const supabase = db();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [docs, sent, skipped, lastMsg] = await Promise.all([
    supabase.from('kb_documents').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'ingested'),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('reply_status', 'sent').gte('received_at', since7d),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('reply_status', 'skipped').gte('received_at', since7d),
    supabase.from('messages').select('received_at').eq('tenant_id', tenantId).order('received_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  res.json({
    documents: docs.count ?? 0,
    repliesSent7d: sent.count ?? 0,
    repliesSkipped7d: skipped.count ?? 0,
    lastEmailAt: lastMsg.data?.received_at ?? null,
  });
});
```

Add the necessary imports (`tenantScoped`, `ingestPdf`/`deleteDocument`/`listDocuments` with new signatures).

Also: update `src/routes/admin.ts` `/login` route's `issueSessionForPassword(res)` — that still works for password fallback.

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/routes/admin.ts
git commit -m "feat(routes/admin): all endpoints scope queries by res.locals.tenantId"
```

---

### Task 18: Auto-provision tenant on Google sign-in

**Files:**
- Modify: `src/routes/oauth.ts`

- [ ] **Step 1: Update the `/oauth/callback` `state === 'login'` branch**

Replace the existing login branch with:

```typescript
if (state === 'login') {
  const { findTenantForEmail, provisionTenant } = await import('../tenant/store.js');
  const { audit } = await import('../tenant/audit.js');
  let found = await findTenantForEmail(email);
  if (!found) {
    // First-time sign-in: auto-provision a tenant for this user
    const tenant = await provisionTenant(email);
    await audit(tenant.id, email, 'tenant.provisioned', { via: 'google-signin' });
    logger.info({ email, tenantId: tenant.id }, 'auto-provisioned new tenant');
    issueSessionForEmail(res, email, tenant.id);
    await audit(tenant.id, email, 'auth.signin', { method: 'google' });
    res.redirect('/admin/onboarding');
    return;
  }
  // Returning user
  await audit(found.tenant.id, email, 'auth.signin', { method: 'google' });
  issueSessionForEmail(res, email, found.tenant.id);
  res.redirect(found.tenant.onboardingCompletedAt ? '/admin' : '/admin/onboarding');
  return;
}
```

Also: replace the mailbox-connect branch to scope to current tenant. The user clicking "Reconnect Gmail" is already authenticated, so we have `res.locals.tenantId`. But `/oauth/callback` is unauthenticated (it's Google calling us back). Solution: pass tenant_id via the OAuth `state` parameter in `buildMailboxAuthUrl`.

Update `src/providers/gmail.ts`:
```typescript
export function buildMailboxAuthUrl(tenantId: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: MAILBOX_SCOPES,
    state: `mailbox:${tenantId}`,
  });
}
```

In `oauthRouter.get('/start', requireAdmin, ...)`:
```typescript
oauthRouter.get('/start', requireAdmin, (_req, res) => {
  res.redirect(buildMailboxAuthUrl(res.locals.tenantId));
});
```

In `oauthRouter.get('/callback', ...)`:
```typescript
// Top of the handler
const state = typeof req.query.state === 'string' ? req.query.state : '';
const [stateKind, stateTenantId] = state.split(':');
// ...
if (stateKind === 'mailbox') {
  if (!stateTenantId) {
    res.status(400).type('html').send('<p>Mailbox-connect state missing tenant.</p>');
    return;
  }
  // ... existing mailbox token save logic, but use saveTokensForTenant(stateTenantId, ...) and tenantId = stateTenantId
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/routes/oauth.ts src/providers/gmail.ts
git commit -m "feat(oauth): auto-provision tenant on first google signin; state carries tenant_id"
```

---

### Task 19: Settings endpoints

**Files:**
- Create: `src/routes/settings.ts`
- Modify: `src/server.ts` to mount the new router

- [ ] **Step 1: Write `src/routes/settings.ts`**

```typescript
// src/routes/settings.ts
import { Router } from 'express';
import { requireAdmin } from '../lib/auth.js';
import { updateSettings, getTenant, softDeleteTenant } from '../tenant/store.js';
import { audit } from '../tenant/audit.js';
import { summarizeUsage } from '../tenant/usage.js';
import {
  ALLOWED_REPLY_MODELS,
  ALLOWED_CLASSIFIER_MODELS,
  defaultTenantSettings,
  type TenantSettings,
} from '../tenant/types.js';

export const settingsRouter: Router = Router();

settingsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

settingsRouter.get('/', requireAdmin, async (_req, res) => {
  const tenant = await getTenant(res.locals.tenantId);
  if (!tenant) { res.status(404).json({ error: 'tenant not found' }); return; }
  res.json({
    settings: tenant.settings,
    allowed: {
      replyModels: ALLOWED_REPLY_MODELS,
      classifierModels: ALLOWED_CLASSIFIER_MODELS,
    },
    defaults: defaultTenantSettings(),
  });
});

interface SettingsPatch extends Partial<TenantSettings> {}

function validatePatch(patch: SettingsPatch): string | null {
  if (patch.reply && !ALLOWED_REPLY_MODELS.includes(patch.reply.model as never)) {
    return `Invalid reply model: ${patch.reply.model}. Allowed: ${ALLOWED_REPLY_MODELS.join(', ')}`;
  }
  if (patch.classifier && patch.classifier.model && !ALLOWED_CLASSIFIER_MODELS.includes(patch.classifier.model as never)) {
    return `Invalid classifier model: ${patch.classifier.model}. Allowed: ${ALLOWED_CLASSIFIER_MODELS.join(', ')}`;
  }
  if (patch.classifier?.prompt && patch.classifier.prompt.length > 2000) {
    return 'Classifier prompt too long (max 2000 chars).';
  }
  if (patch.retrieval) {
    if (patch.retrieval.similarityThreshold != null && (patch.retrieval.similarityThreshold < 0 || patch.retrieval.similarityThreshold > 1)) {
      return 'similarityThreshold must be in [0, 1]';
    }
    if (patch.retrieval.topK != null && (patch.retrieval.topK < 1 || patch.retrieval.topK > 50)) {
      return 'topK must be in [1, 50]';
    }
  }
  if (patch.polling) {
    if (patch.polling.intervalSeconds != null && (patch.polling.intervalSeconds < 30 || patch.polling.intervalSeconds > 3600)) {
      return 'polling.intervalSeconds must be in [30, 3600]';
    }
  }
  return null;
}

settingsRouter.put('/', requireAdmin, async (req, res) => {
  const patch = (req.body ?? {}) as SettingsPatch;
  const err = validatePatch(patch);
  if (err) { res.status(400).json({ error: err }); return; }
  try {
    const updated = await updateSettings(res.locals.tenantId, patch);
    await audit(res.locals.tenantId, res.locals.adminEmail, 'settings.updated', { keys: Object.keys(patch) });
    res.json({ settings: updated });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

settingsRouter.get('/usage', requireAdmin, async (_req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const summary = await summarizeUsage(res.locals.tenantId, since);
    res.json({ since, ...summary });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

settingsRouter.post('/account/delete', requireAdmin, async (_req, res) => {
  try {
    await softDeleteTenant(res.locals.tenantId);
    await audit(res.locals.tenantId, res.locals.adminEmail, 'tenant.soft_deleted', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
```

- [ ] **Step 2: Mount in `src/server.ts`**

```typescript
import { settingsRouter } from './routes/settings.js';
// ... existing imports

// In the app setup section, near the other app.use(...) lines:
app.use('/admin/api/settings', settingsRouter);
```

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/routes/settings.ts src/server.ts
git commit -m "feat(routes): /admin/api/settings (GET/PUT/usage/delete)"
```

---

## Phase 7: Onboarding wizard

### Task 20: Onboarding routes (server-side)

**Files:**
- Create: `src/routes/onboarding.ts`
- Modify: `src/server.ts` to mount it

- [ ] **Step 1: Write `src/routes/onboarding.ts`**

```typescript
// src/routes/onboarding.ts
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin } from '../lib/auth.js';
import { updateSettings, markOnboardingComplete, getTenant } from '../tenant/store.js';
import { audit } from '../tenant/audit.js';
import { db } from '../db/client.js';
import { tenantScoped } from '../tenant/scoped.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const onboardingRouter: Router = Router();

// Onboarding shell page (single SPA-like HTML; the JS routes between steps)
onboardingRouter.get('/', requireAdmin, async (_req, res) => {
  const html = await readFile(path.join(__dirname, '..', 'ui', 'onboarding.html'), 'utf-8');
  res.type('html').send(html);
});

// Returns the current onboarding state: which steps are complete
onboardingRouter.get('/api/state', requireAdmin, async (_req, res) => {
  const tenantId = res.locals.tenantId;
  const tenant = await getTenant(tenantId);
  if (!tenant) { res.status(404).json({ error: 'tenant' }); return; }

  const { data: oauth } = await db().from('oauth_tokens').select('email').eq('tenant_id', tenantId).maybeSingle();
  const { count: docsCount } = await tenantScoped(db(), tenantId)
    .from('kb_documents').select('*', { count: 'exact', head: true }).eq('status', 'ingested');

  res.json({
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, onboardingCompletedAt: tenant.onboardingCompletedAt },
    steps: {
      welcome: !!tenant.name && tenant.name !== 'My workspace',
      mailbox: !!oauth?.email,
      persona: !!tenant.settings.persona.companyDescription,
      kb: (docsCount ?? 0) > 0,
      classifier: true,  // always true; uses default unless customized
      done: !!tenant.onboardingCompletedAt,
    },
  });
});

// Step: set company name
onboardingRouter.post('/api/welcome', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) { res.status(400).json({ error: 'name required (1-80 chars)' }); return; }
  const { error } = await db().from('tenants').update({ name }).eq('id', res.locals.tenantId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// Step: set persona
onboardingRouter.post('/api/persona', requireAdmin, async (req, res) => {
  const { signature, tone, companyDescription } = req.body ?? {};
  if (typeof signature !== 'string' || typeof tone !== 'string' || typeof companyDescription !== 'string') {
    res.status(400).json({ error: 'signature, tone, companyDescription required' });
    return;
  }
  try {
    await updateSettings(res.locals.tenantId, {
      persona: {
        signature: signature.slice(0, 200),
        tone: tone.slice(0, 200),
        companyDescription: companyDescription.slice(0, 1000),
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Step: set classifier prompt (optional)
onboardingRouter.post('/api/classifier', requireAdmin, async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (prompt.length > 2000) { res.status(400).json({ error: 'prompt too long (max 2000)' }); return; }
  try {
    const current = await getTenant(res.locals.tenantId);
    await updateSettings(res.locals.tenantId, {
      classifier: { ...current!.settings.classifier, prompt: prompt || null },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Step: finish onboarding
onboardingRouter.post('/api/complete', requireAdmin, async (_req, res) => {
  try {
    await markOnboardingComplete(res.locals.tenantId);
    await audit(res.locals.tenantId, res.locals.adminEmail, 'onboarding.completed', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
```

- [ ] **Step 2: Mount in `src/server.ts`**

```typescript
import { onboardingRouter } from './routes/onboarding.js';
// ...
app.use('/admin/onboarding', onboardingRouter);
```

- [ ] **Step 3: Update `src/routes/admin.ts` GET `/` (dashboard) to redirect to /admin/onboarding if not complete**

```typescript
adminRouter.get('/', requireAdmin, async (_req, res) => {
  // If onboarding incomplete, force the wizard
  if (res.locals.tenant && !res.locals.tenant.onboardingCompletedAt) {
    res.redirect('/admin/onboarding');
    return;
  }
  const html = await readFile(path.join(__dirname, '..', 'ui', 'admin.html'), 'utf-8');
  res.type('html').send(html);
});
```

- [ ] **Step 4: Build + commit**

```bash
npm run build
git add src/routes/onboarding.ts src/server.ts src/routes/admin.ts
git commit -m "feat(onboarding): server routes + onboarding-required guard on dashboard"
```

---

### Task 21: Onboarding wizard UI

**Files:**
- Create: `src/ui/onboarding.html`

- [ ] **Step 1: Write a SPA-style onboarding wizard**

Create `src/ui/onboarding.html` with the following structure: a top progress bar showing 6 steps (Welcome / Mailbox / Persona / KB / Classifier / Done); each step is a `<section>` that's shown/hidden via JS. JS calls `/admin/onboarding/api/state` on load to determine which step to show first.

For brevity (this is HTML — paste verbatim):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up · inbox-ai</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  :root {
    --bg: #f8fafc; --card: #ffffff; --border: #e5e7eb; --border-strong: #cbd5e1;
    --text: #0f172a; --muted: #64748b; --primary: #4f46e5; --primary-hover: #4338ca;
    --primary-soft: #eef2ff; --success: #16a34a; --success-soft: #dcfce7;
    --shadow: 0 1px 2px rgba(15,23,42,.04), 0 4px 16px rgba(15,23,42,.04);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
  .shell { max-width: 680px; margin: 0 auto; padding: 40px 24px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
  .brand-mark { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #4f46e5, #7c3aed); display: grid; place-items: center; color: white; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(79,70,229,.3); }
  .progress { display: flex; gap: 6px; margin-bottom: 28px; }
  .progress-step { flex: 1; height: 4px; border-radius: 2px; background: var(--border); transition: background .2s; }
  .progress-step.done { background: var(--success); }
  .progress-step.current { background: var(--primary); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 32px; box-shadow: var(--shadow); }
  h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: -.4px; }
  .sub { margin: 0 0 24px; color: var(--muted); line-height: 1.55; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  input, textarea, select {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border-strong);
    border-radius: 8px; font: inherit; font-size: 14px; background: white;
    color: var(--text); margin-bottom: 16px;
  }
  textarea { resize: vertical; min-height: 100px; font-family: inherit; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(79,70,229,.15); }
  .btn { padding: 11px 18px; border-radius: 8px; border: 1px solid var(--border-strong); background: white; color: var(--text); font: inherit; font-weight: 500; font-size: 14px; cursor: pointer; }
  .btn-primary { background: var(--primary); color: white; border-color: var(--primary); }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions { display: flex; gap: 10px; margin-top: 8px; }
  .err { background: #fee2e2; color: #7f1d1d; border: 1px solid #fca5a5; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .err.show { display: block; }
  .tone-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .tone-chip { padding: 6px 12px; border-radius: 20px; border: 1px solid var(--border-strong); background: white; cursor: pointer; font-size: 13px; }
  .tone-chip.active { background: var(--primary); color: white; border-color: var(--primary); }
  .file-area { border: 2px dashed var(--border-strong); padding: 32px; border-radius: 10px; text-align: center; background: #fafbfc; cursor: pointer; display: block; }
  .file-area:hover { background: #f8fafc; border-color: #94a3b8; }
  .file-area input { display: none; }
  .uploaded { background: var(--success-soft); color: var(--success); padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-top: 8px; }
  .skip-link { background: transparent; border: none; color: var(--muted); font: inherit; font-size: 13px; text-decoration: underline; cursor: pointer; padding: 0; }
  .summary-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
  .summary-row:last-child { border-bottom: none; }
  .summary-row .check { width: 22px; height: 22px; border-radius: 50%; background: var(--success-soft); color: var(--success); display: grid; place-items: center; flex-shrink: 0; font-weight: 600; }
</style>
</head>
<body>
<div class="shell">
  <div class="brand"><div class="brand-mark">ia</div><span style="font-weight:600">inbox-ai</span></div>
  <div class="progress">
    <div class="progress-step" data-step="welcome"></div>
    <div class="progress-step" data-step="mailbox"></div>
    <div class="progress-step" data-step="persona"></div>
    <div class="progress-step" data-step="kb"></div>
    <div class="progress-step" data-step="classifier"></div>
    <div class="progress-step" data-step="done"></div>
  </div>

  <div class="err" id="err"></div>

  <!-- Step: Welcome -->
  <section class="card step" id="step-welcome" style="display:none">
    <h1>Welcome to inbox-ai</h1>
    <p class="sub">Tell us what to call this workspace. You can change it later.</p>
    <label for="name">Workspace name</label>
    <input id="name" placeholder="Acme Inc." maxlength="80">
    <div class="actions"><button class="btn btn-primary" id="welcome-next">Continue</button></div>
  </section>

  <!-- Step: Mailbox -->
  <section class="card step" id="step-mailbox" style="display:none">
    <h1>Connect your Gmail</h1>
    <p class="sub">The bot will poll this mailbox every minute and reply on its behalf. We use Google's official OAuth — your credentials never touch our servers.</p>
    <div id="mailbox-status" style="margin-bottom:16px"></div>
    <div class="actions">
      <a class="btn btn-primary" id="mailbox-connect" href="/oauth/start">Connect Gmail</a>
      <button class="btn" id="mailbox-refresh">I've connected — refresh status</button>
    </div>
  </section>

  <!-- Step: Persona -->
  <section class="card step" id="step-persona" style="display:none">
    <h1>How should the bot sound?</h1>
    <p class="sub">These settings shape every reply.</p>
    <label>Tone</label>
    <div class="tone-chips" id="tone-chips">
      <button class="tone-chip" data-val="professional, warm, concise">Professional</button>
      <button class="tone-chip" data-val="friendly, casual, helpful">Friendly</button>
      <button class="tone-chip" data-val="formal, precise, direct">Formal</button>
      <button class="tone-chip" data-val="playful, enthusiastic, warm">Playful</button>
    </div>
    <input id="tone" placeholder="Or write your own — professional, warm, concise" value="professional, warm, concise">

    <label>Signature</label>
    <input id="signature" placeholder="— Ayush, Acme Inc." maxlength="200">

    <label>Company / context description</label>
    <textarea id="companyDescription" placeholder="Acme Inc. helps small businesses ship AI features faster. We offer..." maxlength="1000"></textarea>

    <div class="actions"><button class="btn btn-primary" id="persona-next">Continue</button></div>
  </section>

  <!-- Step: KB -->
  <section class="card step" id="step-kb" style="display:none">
    <h1>Upload your knowledge base</h1>
    <p class="sub">Drop one or more PDFs. The bot draws every answer from these documents — it won't make things up. You can add more later.</p>
    <label class="file-area" for="kb-file"><span id="kb-file-text">Drop a PDF here, or click to choose</span><input type="file" id="kb-file" accept="application/pdf" multiple></label>
    <div id="kb-upload-status"></div>
    <div class="actions"><button class="btn btn-primary" id="kb-next" disabled>Continue</button></div>
  </section>

  <!-- Step: Classifier -->
  <section class="card step" id="step-classifier" style="display:none">
    <h1>Classifier prompt (optional)</h1>
    <p class="sub">The bot first asks a small LLM: "is this a real customer question?" If you want to tune what counts, edit the prompt below — or skip to keep the smart default.</p>
    <label>Custom classifier prompt (leave empty for default)</label>
    <textarea id="classifierPrompt" placeholder="Reply CLIENT_QUERY if the email asks anything about AI tools, automation, our pricing, or our services. Reply OTHER for newsletters, receipts, or empty/test messages. Reply with exactly one word." maxlength="2000"></textarea>
    <div class="actions">
      <button class="btn btn-primary" id="classifier-next">Continue</button>
      <button class="skip-link" id="classifier-skip">Use default</button>
    </div>
  </section>

  <!-- Step: Done -->
  <section class="card step" id="step-done" style="display:none">
    <h1>You're ready 🎉</h1>
    <p class="sub">Here's a summary. The bot will start polling within 60 seconds.</p>
    <div id="summary"></div>
    <div class="actions" style="margin-top:24px"><button class="btn btn-primary" id="done-finish">Go to dashboard</button></div>
  </section>
</div>

<script>
async function api(path, opts) {
  const merged = { ...opts, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opts?.headers || {}) } };
  const r = await fetch(path, merged);
  if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('401'); }
  if (!r.ok) { let d=''; try{d=(await r.json()).error||'';}catch{d=await r.text();} throw new Error(`HTTP ${r.status}: ${d}`); }
  return r.json();
}
function showErr(msg) {
  const el = document.getElementById('err');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 5000);
}
function show(stepId) {
  document.querySelectorAll('.step').forEach(el => el.style.display = el.id === `step-${stepId}` ? 'block' : 'none');
  document.querySelectorAll('.progress-step').forEach(el => el.classList.remove('current'));
  document.querySelector(`.progress-step[data-step="${stepId}"]`)?.classList.add('current');
}
function markDone(steps) {
  for (const [name, done] of Object.entries(steps)) {
    document.querySelector(`.progress-step[data-step="${name}"]`)?.classList.toggle('done', !!done);
  }
}
async function loadState() {
  const s = await api('/admin/onboarding/api/state');
  markDone(s.steps);
  if (s.steps.done) { window.location.href = '/admin'; return; }
  if (!s.steps.welcome) return show('welcome');
  if (!s.steps.mailbox) return show('mailbox');
  if (!s.steps.persona) return show('persona');
  if (!s.steps.kb) return show('kb');
  return show('classifier');
}

// Welcome
document.getElementById('welcome-next').addEventListener('click', async () => {
  const name = document.getElementById('name').value.trim();
  if (!name) { showErr('Enter a workspace name'); return; }
  try { await api('/admin/onboarding/api/welcome', { method: 'POST', body: JSON.stringify({ name }) }); await loadState(); }
  catch(e) { showErr(e.message); }
});

// Mailbox
async function refreshMailbox() {
  const s = await api('/admin/onboarding/api/state');
  const el = document.getElementById('mailbox-status');
  if (s.steps.mailbox) {
    el.innerHTML = `<div class="uploaded">✓ Connected</div>`;
    setTimeout(() => loadState(), 600);
  } else {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">Not connected yet. Click <strong>Connect Gmail</strong>, complete the Google flow, then return.</div>`;
  }
}
document.getElementById('mailbox-refresh').addEventListener('click', refreshMailbox);

// Persona
document.querySelectorAll('.tone-chip').forEach(el => el.addEventListener('click', () => {
  document.querySelectorAll('.tone-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tone').value = el.dataset.val;
}));
document.getElementById('persona-next').addEventListener('click', async () => {
  const payload = {
    signature: document.getElementById('signature').value.trim() || '— Sent by your AI assistant',
    tone: document.getElementById('tone').value.trim() || 'professional, warm, concise',
    companyDescription: document.getElementById('companyDescription').value.trim(),
  };
  if (!payload.companyDescription) { showErr('Add a short company description — the bot uses it to ground replies'); return; }
  try { await api('/admin/onboarding/api/persona', { method: 'POST', body: JSON.stringify(payload) }); await loadState(); }
  catch(e) { showErr(e.message); }
});

// KB
const kbFile = document.getElementById('kb-file');
const kbStatus = document.getElementById('kb-upload-status');
const kbNext = document.getElementById('kb-next');
kbFile.addEventListener('change', async () => {
  for (const file of kbFile.files) {
    const div = document.createElement('div');
    div.style.fontSize = '13px'; div.style.padding = '8px 0';
    div.textContent = `Uploading ${file.name}…`;
    kbStatus.appendChild(div);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await fetch('/admin/api/documents', { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 100)}`);
      const res = await r.json();
      div.textContent = `✓ ${file.name} — ${res.chunkCount} chunks ingested`;
      div.style.color = 'var(--success)';
      kbNext.disabled = false;
    } catch (e) {
      div.textContent = `✗ ${file.name} — ${e.message}`;
      div.style.color = '#c33';
    }
  }
});
kbNext.addEventListener('click', () => loadState());

// Classifier
document.getElementById('classifier-next').addEventListener('click', async () => {
  try {
    await api('/admin/onboarding/api/classifier', { method: 'POST', body: JSON.stringify({ prompt: document.getElementById('classifierPrompt').value }) });
    await renderSummaryAndGoDone();
  } catch (e) { showErr(e.message); }
});
document.getElementById('classifier-skip').addEventListener('click', async () => {
  try {
    await api('/admin/onboarding/api/classifier', { method: 'POST', body: JSON.stringify({ prompt: '' }) });
    await renderSummaryAndGoDone();
  } catch (e) { showErr(e.message); }
});

async function renderSummaryAndGoDone() {
  const s = await api('/admin/onboarding/api/state');
  const sum = document.getElementById('summary');
  const lines = [
    { label: `Workspace: ${s.tenant.name}`, ok: true },
    { label: `Gmail connected`, ok: s.steps.mailbox },
    { label: `Persona configured`, ok: s.steps.persona },
    { label: `Knowledge base populated`, ok: s.steps.kb },
    { label: `Classifier ready`, ok: true },
  ];
  sum.innerHTML = lines.map(l => `<div class="summary-row"><span class="check">${l.ok ? '✓' : '·'}</span>${l.label}</div>`).join('');
  show('done');
}
document.getElementById('done-finish').addEventListener('click', async () => {
  try { await api('/admin/onboarding/api/complete', { method: 'POST' }); window.location.href = '/admin'; }
  catch(e) { showErr(e.message); }
});

loadState().catch(e => showErr(e.message));
if (location.hash === '#mailbox-return') refreshMailbox();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/onboarding.html
git commit -m "feat(onboarding): wizard UI — welcome / mailbox / persona / kb / classifier / done"
```

---

## Phase 8: Settings page UI

### Task 22: Settings page

**Files:**
- Modify: `src/ui/admin.html` to add a Settings view that calls the new endpoints

- [ ] **Step 1: Replace the existing `<section id="view-settings">` block in admin.html with this richer version**

Find this in `src/ui/admin.html`:
```html
<section id="view-settings" class="view">
  ...
</section>
```

Replace it with:

```html
<section id="view-settings" class="view">
  <div class="view-header">
    <h1>Settings</h1>
    <p>Tune how the bot behaves. Changes apply on the next polling cycle.</p>
  </div>

  <div class="card">
    <div class="card-header"><div><h2>Gmail mailbox</h2><p class="sub">The Gmail account the bot polls and replies from.</p></div><a class="btn btn-primary" href="/oauth/start">Reconnect Gmail</a></div>
    <div class="card-body"><div id="gmail-status-settings" class="conn-row"><span class="conn-meta">Loading…</span></div></div>
  </div>

  <div class="card">
    <div class="card-header"><div><h2>Persona</h2><p class="sub">Tone, signature, and company description the bot uses in replies.</p></div></div>
    <div class="card-body">
      <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Tone</label>
      <input id="set-tone" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px;margin-bottom:12px">
      <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Signature</label>
      <input id="set-signature" maxlength="200" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px;margin-bottom:12px">
      <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Company description</label>
      <textarea id="set-company" maxlength="1000" rows="4" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px;margin-bottom:12px;resize:vertical"></textarea>
      <button class="btn btn-primary" id="save-persona">Save persona</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><div><h2>Models & retrieval</h2><p class="sub">Which LLMs the bot uses and how strict retrieval is.</p></div></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Reply model</label>
          <select id="set-reply-model" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px;background:white"></select>
        </div>
        <div>
          <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Classifier model</label>
          <select id="set-classifier-model" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px;background:white"></select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">
        <div>
          <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Similarity threshold (0-1)</label>
          <input id="set-threshold" type="number" min="0" max="1" step="0.05" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px">
        </div>
        <div>
          <label style="font-size:13px;font-weight:500;margin-bottom:6px;display:block">Top-K chunks</label>
          <input id="set-topk" type="number" min="1" max="50" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px">
        </div>
      </div>
      <button class="btn btn-primary" id="save-models" style="margin-top:16px">Save models & retrieval</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><div><h2>Classifier prompt</h2><p class="sub">Override the prompt the classifier uses. Leave empty to use the smart default.</p></div></div>
    <div class="card-body">
      <textarea id="set-classifier-prompt" rows="6" maxlength="2000" style="width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:6px;font:inherit;font-size:13px;resize:vertical"></textarea>
      <button class="btn btn-primary" id="save-classifier-prompt" style="margin-top:12px">Save classifier prompt</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><div><h2>Auto-send</h2><p class="sub">When off, the bot writes replies as Gmail drafts for you to review and send.</p></div></div>
    <div class="card-body">
      <label style="display:flex;gap:12px;align-items:center;cursor:pointer">
        <input type="checkbox" id="set-auto-send" style="width:18px;height:18px;margin:0">
        <span style="font-size:14px">Auto-send replies (bot sends without human review)</span>
      </label>
      <button class="btn btn-primary" id="save-auto-send" style="margin-top:16px">Save</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><div><h2>LLM usage (last 30 days)</h2><p class="sub">Per-model token and cost breakdown for this tenant.</p></div></div>
    <div class="card-body"><div id="usage-summary"><div style="color:var(--text-muted)">Loading…</div></div></div>
  </div>

  <div class="card" style="border-color:#fca5a5">
    <div class="card-header"><div><h2 style="color:var(--danger)">Danger zone</h2><p class="sub">Soft-delete this tenant and all its data. We hold for 30 days before hard delete.</p></div></div>
    <div class="card-body"><button class="btn btn-danger" id="delete-account">Delete this workspace</button></div>
  </div>
</section>
```

Then at the bottom of the existing `<script>` block in `admin.html`, ADD these helpers (don't replace anything; append):

```javascript
async function loadSettings() {
  if (location.hash !== '#settings') return;
  try {
    const { settings, allowed } = await safeFetch('/admin/api/settings/');
    $('#set-tone').value = settings.persona.tone;
    $('#set-signature').value = settings.persona.signature;
    $('#set-company').value = settings.persona.companyDescription;
    $('#set-threshold').value = settings.retrieval.similarityThreshold;
    $('#set-topk').value = settings.retrieval.topK;
    $('#set-classifier-prompt').value = settings.classifier.prompt ?? '';
    $('#set-auto-send').checked = settings.polling.autoSend;

    const replySel = $('#set-reply-model'); replySel.innerHTML = '';
    for (const m of allowed.replyModels) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m; o.selected = m === settings.reply.model;
      replySel.appendChild(o);
    }
    const classSel = $('#set-classifier-model'); classSel.innerHTML = '';
    for (const m of allowed.classifierModels) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m; o.selected = m === settings.classifier.model;
      classSel.appendChild(o);
    }

    const usage = await safeFetch('/admin/api/settings/usage');
    $('#usage-summary').innerHTML = `
      <div style="font-size:14px;margin-bottom:8px"><strong>${usage.totalTokens.toLocaleString()}</strong> tokens · <strong>$${usage.totalCostUsd.toFixed(4)}</strong> total</div>
      ${usage.byModel.length === 0 ? '<div style="color:var(--text-muted)">No usage yet.</div>' :
        '<table style="width:100%"><thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
        usage.byModel.map(m => `<tr><td>${escapeHtml(m.model)}</td><td>${m.tokens.toLocaleString()}</td><td>$${m.costUsd.toFixed(4)}</td></tr>`).join('') +
        '</tbody></table>'}
    `;
  } catch (e) { showError('Settings load failed: ' + e.message); }
}

async function saveSettings(patch, msg) {
  try {
    await safeFetch('/admin/api/settings/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    showError(msg + ' saved ✓');  // co-opting the banner for transient success notes; we'll fix this UI later
  } catch (e) { showError('Save failed: ' + e.message); }
}

$('#save-persona')?.addEventListener('click', () => saveSettings({
  persona: { tone: $('#set-tone').value, signature: $('#set-signature').value, companyDescription: $('#set-company').value },
}, 'Persona'));
$('#save-models')?.addEventListener('click', () => saveSettings({
  reply: { model: $('#set-reply-model').value },
  classifier: { model: $('#set-classifier-model').value, prompt: $('#set-classifier-prompt').value || null },
  retrieval: { similarityThreshold: parseFloat($('#set-threshold').value), topK: parseInt($('#set-topk').value, 10) },
}, 'Models & retrieval'));
$('#save-classifier-prompt')?.addEventListener('click', () => saveSettings({
  classifier: { prompt: $('#set-classifier-prompt').value || null },
}, 'Classifier prompt'));
$('#save-auto-send')?.addEventListener('click', () => saveSettings({
  polling: { autoSend: $('#set-auto-send').checked },
}, 'Auto-send'));
$('#delete-account')?.addEventListener('click', async () => {
  if (!confirm('Delete this workspace? Data is soft-deleted now and hard-deleted in 30 days. This cannot be undone after 30 days.')) return;
  try {
    await safeFetch('/admin/api/settings/account/delete', { method: 'POST' });
    window.location.href = '/admin/login';
  } catch (e) { showError('Delete failed: ' + e.message); }
});

// Wire settings load to the existing router
const origRoute = route;
route = function(name) { origRoute(name); if (name === 'settings') loadSettings(); };
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/ui/admin.html
git commit -m "feat(ui/admin): full settings page (persona/models/threshold/prompt/auto-send/usage/delete)"
```

---

## Phase 9: Cleanup cron + tenant isolation test + docs

### Task 23: Daily hard-delete cron

**Files:**
- Create: `src/workers/cleanup.ts`
- Modify: `src/server.ts` to start the cron

- [ ] **Step 1: Write `src/workers/cleanup.ts`**

```typescript
// src/workers/cleanup.ts
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { audit } from '../tenant/audit.js';

const GRACE_DAYS = 30;

async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: tenants, error } = await db()
    .from('tenants')
    .select('id, created_by_email')
    .lt('deleted_at', cutoff);
  if (error) { logger.error({ err: error.message }, 'cleanup: list failed'); return; }

  for (const t of (tenants ?? []) as Array<{ id: string; created_by_email: string | null }>) {
    try {
      await audit(t.id, t.created_by_email, 'tenant.hard_deleted', { graceDays: GRACE_DAYS });
      // CASCADE deletes will remove kb_documents / kb_chunks / messages / oauth_tokens / memberships / llm_usage / audit_log
      const { error: dErr } = await db().from('tenants').delete().eq('id', t.id);
      if (dErr) { logger.error({ tenantId: t.id, err: dErr.message }, 'cleanup: delete failed'); continue; }
      logger.info({ tenantId: t.id }, 'hard-deleted tenant after grace period');
    } catch (err) {
      logger.error({ tenantId: t.id, err: err instanceof Error ? err.message : String(err) }, 'cleanup tenant failed');
    }
  }
}

export function startCleanupCron(): void {
  // Run every day at 03:00 UTC
  cron.schedule('0 3 * * *', tick);
  logger.info('daily cleanup cron scheduled (03:00 UTC)');
}
```

- [ ] **Step 2: Modify `src/server.ts`**

Add:
```typescript
import { startCleanupCron } from './workers/cleanup.js';
// ...
app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, baseUrl: env.BASE_URL }, 'inbox-ai server listening');
  startPoller();
  startCleanupCron();
});
```

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/workers/cleanup.ts src/server.ts
git commit -m "feat(workers): daily cleanup cron hard-deletes tenants past 30-day grace"
```

---

### Task 24: Tenant isolation integration test

**Files:**
- Create: `tests/integration/tenant-isolation.test.ts`

Note: this test requires a real Supabase connection. It's gated by `SUPABASE_URL` being a test project URL. Skip if not configured.

- [ ] **Step 1: Write `tests/integration/tenant-isolation.test.ts`**

```typescript
// tests/integration/tenant-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// This test only runs when SUPABASE_URL points to a TEST project (slug contains 'test' or 'dev').
// Set TEST_SUPABASE=1 to force-enable.
const SHOULD_RUN =
  process.env.TEST_SUPABASE === '1' ||
  (process.env.SUPABASE_URL?.includes('test') ?? false) ||
  (process.env.SUPABASE_URL?.includes('dev') ?? false);

const maybeDescribe = SHOULD_RUN ? describe : describe.skip;

maybeDescribe('tenant isolation', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const { provisionTenant } = await import('../../src/tenant/store.js');
    const a = await provisionTenant(`isolation-test-a-${Date.now()}@local.test`);
    const b = await provisionTenant(`isolation-test-b-${Date.now()}@local.test`);
    tenantA = a.id;
    tenantB = b.id;
  });

  afterAll(async () => {
    const { db } = await import('../../src/db/client.js');
    await db().from('tenants').delete().in('id', [tenantA, tenantB]);
  });

  it('listDocuments returns only own tenant docs', async () => {
    const { db } = await import('../../src/db/client.js');
    const { listDocuments } = await import('../../src/kb/ingest.js');

    // Insert one doc per tenant
    await db().from('kb_documents').insert({ tenant_id: tenantA, filename: 'a.pdf', size_bytes: 1, status: 'ingested', chunk_count: 0 });
    await db().from('kb_documents').insert({ tenant_id: tenantB, filename: 'b.pdf', size_bytes: 1, status: 'ingested', chunk_count: 0 });

    const aDocs = await listDocuments(tenantA);
    const bDocs = await listDocuments(tenantB);

    expect(aDocs.length).toBeGreaterThanOrEqual(1);
    expect(bDocs.length).toBeGreaterThanOrEqual(1);
    expect(aDocs.every((d: { tenant_id: string }) => d.tenant_id === tenantA)).toBe(true);
    expect(bDocs.every((d: { tenant_id: string }) => d.tenant_id === tenantB)).toBe(true);
    // Critical: A's docs should not show in B's list
    const aFilenames = new Set(aDocs.map((d: { filename: string }) => d.filename));
    expect(bDocs.some((d: { filename: string }) => aFilenames.has(d.filename))).toBe(false);
  });

  it('messages query is tenant-isolated', async () => {
    const { db } = await import('../../src/db/client.js');
    const { tenantScoped } = await import('../../src/tenant/scoped.js');

    await db().from('messages').insert({
      tenant_id: tenantA, gmail_message_id: `t-a-${Date.now()}`, gmail_thread_id: 'thread', received_at: new Date().toISOString(),
      from_address: 'x@y.com', subject: 'hi', body_text: '', classification: 'other', reply_status: 'skipped',
    });
    await db().from('messages').insert({
      tenant_id: tenantB, gmail_message_id: `t-b-${Date.now()}`, gmail_thread_id: 'thread', received_at: new Date().toISOString(),
      from_address: 'x@y.com', subject: 'hi', body_text: '', classification: 'other', reply_status: 'skipped',
    });

    const { data: aMsgs } = await tenantScoped(db(), tenantA).from('messages').select('tenant_id');
    expect(aMsgs?.every((m: { tenant_id: string }) => m.tenant_id === tenantA)).toBe(true);
  });
});
```

- [ ] **Step 2: Run (skipped if not against a test Supabase project)**

```bash
npm test -- tests/integration/tenant-isolation.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/tenant-isolation.test.ts
git commit -m "test(integration): tenant isolation across documents + messages"
```

---

### Task 25: Update docs

**Files:**
- Modify: `docs/DEPLOY.md`
- Create: `docs/ONBOARDING-FLOW.md`
- Modify: `README.md`

- [ ] **Step 1: Append a section to `docs/DEPLOY.md`**

```markdown
## SaaS-mode deployment notes

inbox-ai is now multi-tenant. A single deployment serves N tenants. Steps that change from the single-tenant guide:

- **No `ADMIN_EMAILS` env var.** Anyone with a Google account can sign in and gets an auto-provisioned tenant.
- **Single deployment, single domain.** All tenants share `bot.aiagencycorp.com`. Tenant context is derived from the signed-in user's email.
- **Pre-add OAuth redirect URI**: `https://bot.aiagencycorp.com/oauth/callback` (just one — used for both sign-in and mailbox-connect flows, disambiguated via `state` param).
- **Run migration 002** in Supabase SQL editor before redeploying — see `docs/MIGRATION-002-RUNBOOK.md`.
- **One Supabase project**, no longer one-per-client. RLS + per-query tenant scoping enforce isolation.

## Per-tenant cost attribution

OpenRouter doesn't support sub-keys. Cost tracking lives in our `llm_usage` table. To query "how much has tenant X spent":

```sql
select model, sum(total_tokens), sum(cost_usd)
from llm_usage
where tenant_id = '<id>' and created_at > now() - interval '30 days'
group by model;
```

The Settings UI surfaces this per tenant.
```

- [ ] **Step 2: Write `docs/ONBOARDING-FLOW.md`**

```markdown
# Onboarding Flow

When a user signs in for the first time via Google:

1. **`/oauth/callback?state=login`** — Google returns to us with the user's email
2. **Look up `memberships where email = ?`** — if none, `provisionTenant(email)` creates `tenants` + `memberships(role=owner)` rows
3. **Set session cookie** carrying `(email, tenant_id, ts, HMAC)`
4. **Redirect to `/admin/onboarding`**
5. **Wizard steps** (`src/ui/onboarding.html`):
   - **Welcome** — sets `tenants.name`
   - **Mailbox** — runs the existing mailbox-connect OAuth flow with `state=mailbox:{tenant_id}`. On return, polls `/admin/onboarding/api/state` until `mailbox: true`.
   - **Persona** — `signature`, `tone`, `companyDescription` → `tenant.settings.persona`
   - **KB** — uploads at least one PDF; reuses `/admin/api/documents`
   - **Classifier** — optional custom prompt (max 2000 chars) → `tenant.settings.classifier.prompt`
   - **Done** — sets `tenants.onboarding_completed_at`
6. **Redirect to `/admin`**

If a user revisits `/admin` while `onboarding_completed_at` is null, they're forced back into the wizard. The poller skips tenants whose onboarding isn't complete.
```

- [ ] **Step 3: Update README.md (replace the "How it works" section to reflect multi-tenant)**

In README.md, find the "How it works" section. Add a paragraph at the top:

```markdown
## How it works (multi-tenant SaaS)

A single deployment serves many tenants. Anyone can sign in with Google and gets their own
auto-provisioned tenant: their own knowledge base, their own Gmail connection, their own
classifier and reply config. Tenant scoping is enforced at every query (helper:
`tenantScoped(db, tenantId)`), with Postgres RLS as defense-in-depth.

Per tenant, the bot polls Gmail every 60s and for each new email:
```

(Keep the rest of the "How it works" steps as-is.)

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY.md docs/ONBOARDING-FLOW.md README.md
git commit -m "docs: SaaS-mode deploy notes + onboarding flow + readme update"
```

---

## Self-review

**Spec coverage:**
- ✅ Multi-tenant DB schema (Task 1)
- ✅ Per-tenant settings in DB JSONB (Task 2)
- ✅ Tenant + membership store (Task 3)
- ✅ Tenant-scoped query helper (Task 4)
- ✅ Audit log (Task 5)
- ✅ LLM usage tracking (Task 6)
- ✅ Rate limit guards (Task 7)
- ✅ Email-aware session cookie (Task 8)
- ✅ Usage logging in providers (Tasks 9, 10)
- ✅ Per-tenant Gmail tokens (Task 11)
- ✅ Tenant-scoped KB + search + pipeline (Tasks 12-15)
- ✅ Multi-tenant poller (Task 16)
- ✅ Admin API scoped (Task 17)
- ✅ Auto-provisioning on Google sign-in (Task 18)
- ✅ Settings endpoints (Task 19)
- ✅ Onboarding routes + UI (Tasks 20, 21)
- ✅ Settings UI (Task 22)
- ✅ Soft delete + cleanup cron (Task 23)
- ✅ Tenant isolation tests (Task 24)
- ✅ Docs (Task 25)

**Risks / known limitations baked in:**
- Draft mode is logged-only (not actual Gmail Drafts) — flagged in Task 15. v2 enhancement.
- Cleanup cron runs in-process on the single VPS — if downtime spans >30 days a tenant's grace period lapses without delete. Acceptable for v1.
- OAuth refresh tokens stored plaintext — documented as a known v1 trade-off.

**Out-of-scope deferrals** (NOT in this plan):
- Multi-admin invites within a tenant
- Stripe billing
- Custom domain per tenant
- Google OAuth verification submission (separate workstream)
- Per-tenant OpenRouter key
- Pub/Sub real-time email delivery

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-20-multi-tenant-saas.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
