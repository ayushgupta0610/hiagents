create extension if not exists vector;
create extension if not exists pgcrypto;

-- Documents (one row per PDF)
create table kb_documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  size_bytes integer not null,
  uploaded_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'ingested', 'failed')),
  chunk_count integer,
  error text
);

create index idx_kb_documents_uploaded_at on kb_documents (uploaded_at desc);

-- Chunks (one row per chunk, with embedding)
create table kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create index idx_kb_chunks_document on kb_chunks (document_id);
create index idx_kb_chunks_embedding on kb_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Email audit log
create table messages (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text unique not null,
  gmail_thread_id text not null,
  received_at timestamptz not null,
  from_address text not null,
  subject text,
  body_text text,
  classification text check (classification in ('client_query', 'other', 'skipped_loop', 'skipped_thread', 'skipped_self', 'error')),
  retrieved_chunk_ids uuid[],
  top_similarity float,
  reply_text text,
  reply_status text check (reply_status in ('sent', 'drafted', 'skipped', 'failed')),
  reply_reason text,
  reply_sent_at timestamptz,
  reply_gmail_message_id text,
  created_at timestamptz not null default now()
);

create index idx_messages_thread on messages (gmail_thread_id);
create index idx_messages_received_at on messages (received_at desc);

-- Gmail OAuth token (singleton row, one mailbox per deployment)
create table oauth_tokens (
  id integer primary key check (id = 1),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null,
  email text not null,
  updated_at timestamptz not null default now()
);

-- Vector search RPC (used by KB search)
create or replace function match_kb_chunks(
  query_embedding vector(1536),
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
as $$
begin
  return query
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from kb_chunks c
  where 1 - (c.embedding <=> query_embedding) > similarity_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;
