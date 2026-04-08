-- ============================================================
-- LangChain Vector Store & AI Feedback Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Enable the pgvector extension (must be done before creating vector columns)
create extension if not exists vector
  with schema extensions;

-- 2. Create the unified embeddings table for LangChain SupabaseVectorStore
-- Stores embedded documents (tasks, prompts, or any app content)
create table if not exists app_embeddings (
  id           bigserial primary key,
  content      text,                         -- the raw text content
  metadata     jsonb,                        -- arbitrary metadata (user_id, source_type, etc.)
  embedding    vector(768)                   -- Gemini text-embedding-004 uses 768 dimensions
);

-- Index for fast similarity search
create index if not exists app_embeddings_embedding_idx
  on app_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 3. RPC function required by LangChain SupabaseVectorStore
-- Performs cosine similarity search and returns matching documents
create or replace function match_documents (
  query_embedding vector(768),
  match_count     int default 5,
  filter          jsonb default '{}'
)
returns table (
  id        bigint,
  content   text,
  metadata  jsonb,
  similarity float
)
language plpgsql
as $$
#variable_conflict use_column
begin
  return query
  select
    id,
    content,
    metadata,
    1 - (app_embeddings.embedding <=> query_embedding) as similarity
  from app_embeddings
  where metadata @> filter
  order by app_embeddings.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 4. AI Feedback table
-- Stores user thumbs-up / thumbs-down feedback on /ask responses
create table if not exists ai_feedback (
  id          bigserial primary key,
  user_id     bigint not null,
  message_id  bigint not null,
  type        text not null check (type in ('thumbs_up', 'thumbs_down')),
  created_at  timestamp with time zone default now()
);

-- Index for fast user-based lookups
create index if not exists ai_feedback_user_id_idx
  on ai_feedback (user_id);
