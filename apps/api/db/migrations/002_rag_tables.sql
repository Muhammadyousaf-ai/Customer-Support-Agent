-- RAG storage. Replaces the Phase 1 placeholder tables (no data worth keeping yet).
drop table if exists document_chunks;
drop table if exists documents;

create table documents (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  category text not null,
  content text not null,
  version text not null,
  checksum text not null,
  created_at timestamptz not null default now()
);

create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  content text not null,
  heading text not null,
  embedding vector(1536) not null,
  applicable_tiers text[] not null,
  contract_types text[] not null,
  metadata jsonb not null default '{}'::jsonb,
  chunk_index int not null,
  unique (document_id, chunk_index)
);

create index document_chunks_document_idx on document_chunks (document_id);
create index document_chunks_embedding_idx on document_chunks using hnsw (embedding vector_cosine_ops);
