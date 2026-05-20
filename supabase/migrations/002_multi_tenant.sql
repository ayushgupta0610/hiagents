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

commit;
