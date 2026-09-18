-- My Helper Bot - Supabase Database Schema
-- Run this in your Supabase SQL Editor to set up the required tables

-- Table: user_data
-- Stores user-specific key-value data
CREATE TABLE IF NOT EXISTS user_data (
  user_id BIGINT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add comment to table
COMMENT ON TABLE user_data IS 'Stores user-specific data in JSONB format for flexible key-value storage';

-- Table: command_history
-- Logs all command usage for analytics
CREATE TABLE IF NOT EXISTS command_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  command TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add comment to table
COMMENT ON TABLE command_history IS 'Logs command usage history for analytics and debugging';

-- Table: tasks
-- Stores user-created to-do tasks
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE tasks IS 'Stores user to-do tasks created from the /task command';

-- Table: prompts
-- Stores prompt templates created from /prompt, including the Telegram file_id
-- of the associated image (the file itself lives on Telegram's servers).
CREATE TABLE IF NOT EXISTS prompts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  image_file_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE prompts IS 'Stores prompt templates and their Telegram image file_id, created from the /prompt command';

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_command_history_user_id ON command_history(user_id);
CREATE INDEX IF NOT EXISTS idx_command_history_created_at ON command_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_history_command ON command_history(command);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompts_user_id ON prompts(user_id);
CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at DESC);
-- GIN index supports the tag containment filter used by /getprompt -tag
CREATE INDEX IF NOT EXISTS idx_prompts_tags ON prompts USING GIN(tags);

-- Optional: Enable Row Level Security (RLS) for better security
-- Uncomment if you want to enable RLS (recommended for production)

-- ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE command_history ENABLE ROW LEVEL SECURITY;

-- Create policies (adjust based on your security needs)
-- These policies allow service role (your bot) to access all data

-- CREATE POLICY "Service role can access all user_data"
--   ON user_data
--   FOR ALL
--   TO service_role
--   USING (true)
--   WITH CHECK (true);

-- CREATE POLICY "Service role can access all command_history"
--   ON command_history
--   FOR ALL
--   TO service_role
--   USING (true)
--   WITH CHECK (true);

-- Optional: Create a function to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for user_data
DROP TRIGGER IF EXISTS update_user_data_updated_at ON user_data;
CREATE TRIGGER update_user_data_updated_at
    BEFORE UPDATE ON user_data
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create trigger for prompts
DROP TRIGGER IF EXISTS update_prompts_updated_at ON prompts;
CREATE TRIGGER update_prompts_updated_at
    BEFORE UPDATE ON prompts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Assistant foundation tables
-- ============================================================

-- Conversation memory. One row per message so history survives restarts and
-- can be replayed to the model.
CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE conversations IS 'Assistant conversation memory, replayed to the model for context';

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id, id DESC);

-- Durable facts and preferences ("home_city", "diet", ...).
CREATE TABLE IF NOT EXISTS facts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, key)
);

COMMENT ON TABLE facts IS 'Long-lived facts and preferences the assistant remembers about the user';

-- Reminders. next_run_at is an absolute instant; the wall-clock columns
-- describe recurring schedules so "every Monday 09:00" survives DST changes.
CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  next_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'once' CHECK (frequency IN ('once', 'daily', 'weekly', 'monthly')),
  time_of_day TEXT,
  day_of_week SMALLINT CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6)),
  day_of_month SMALLINT CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 31)),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE reminders IS 'Scheduled reminders polled by the reminder scheduler';

-- The scheduler's hot query: active reminders that are due.
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(next_run_at) WHERE active;
CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);

-- Write tools waiting for the user to tap Confirm. The model turn that
-- requested the call is stored so the conversation can resume afterwards.
CREATE TABLE IF NOT EXISTS pending_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  tool_name TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

COMMENT ON TABLE pending_actions IS 'Write-tool confirmations awaiting a user tap';

CREATE INDEX IF NOT EXISTS idx_pending_actions_expires_at ON pending_actions(expires_at);

-- Provider credentials (Google refresh token, API tokens). Never readable with
-- the public key: RLS is enabled below with only a service_role policy.
CREATE TABLE IF NOT EXISTS credentials (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  provider TEXT NOT NULL,
  secret JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

COMMENT ON TABLE credentials IS 'OAuth refresh tokens and API credentials, service_role only';

DROP TRIGGER IF EXISTS update_credentials_updated_at ON credentials;
CREATE TRIGGER update_credentials_updated_at
    BEFORE UPDATE ON credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Row Level Security
-- ============================================================
-- These tables hold private conversations and secrets, so they are closed to
-- the public key entirely. The bot reaches them with SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS. Explicit policies document that intent and mean the same
-- migration also works on a project where RLS was already enabled by hand.

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
BEGIN
  -- The service_role is created by Supabase. A plain Postgres instance (used
  -- for local testing) will not have it, so skip policy creation there rather
  -- than failing the whole migration. On Supabase, service_role also carries
  -- BYPASSRLS, so these policies are belt-and-braces documentation of intent.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE 'role service_role not found; skipping RLS policies (expected outside Supabase)';
    RETURN;
  END IF;

  FOREACH target IN ARRAY ARRAY['conversations', 'facts', 'reminders', 'pending_actions', 'credentials']
  LOOP
    -- CREATE POLICY has no IF NOT EXISTS, so a duplicate is swallowed by name.
    -- That keeps this file safe to re-run, which matters because it is applied
    -- as a whole script.
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        'service_role_full_access', target);
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END LOOP;
END $$;

-- Verification queries
-- Run these to verify your tables were created successfully:

-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- SELECT * FROM user_data LIMIT 5;
-- SELECT * FROM command_history ORDER BY created_at DESC LIMIT 10;
-- SELECT id, title, tags FROM prompts ORDER BY created_at DESC LIMIT 10;
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('conversations','facts','reminders','pending_actions','credentials');
