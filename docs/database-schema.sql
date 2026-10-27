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

-- Facts are ranked by whether the model should know them unprompted.
--   core      always injected into the prompt (diet, home city, timezone)
--   reference looked up only when relevant (wifi password, locker code)
-- Core facts are capped before injection, so this split is what keeps prompt
-- size bounded while reference material stays available on demand.
-- Added separately so it applies cleanly to a database created before it.
ALTER TABLE facts ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'reference';
DO $$
BEGIN
  ALTER TABLE facts ADD CONSTRAINT facts_tier_check CHECK (tier IN ('core', 'reference'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_facts_tier ON facts(user_id, tier);

COMMENT ON TABLE facts IS 'Long-lived facts and preferences the assistant remembers about the user';
COMMENT ON COLUMN facts.tier IS 'core = always in the prompt; reference = looked up on demand';

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

-- Original user request time is distinct from when model processing completed.
-- Nullable for rolling upgrades; old confirmations use created_at as a fallback.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP WITH TIME ZONE;
UPDATE pending_actions SET requested_at = created_at WHERE requested_at IS NULL;

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

-- Health probe target. The readiness check upserts one fixed row here to prove
-- writes work, which is the only way to detect a wrong Supabase key: with RLS,
-- reads return zero rows instead of erroring. A dedicated table with a
-- caller-supplied key means a monitor polling every 30s can never accumulate
-- rows or inflate a sequence.
CREATE TABLE IF NOT EXISTS health_probes (
  id TEXT PRIMARY KEY,
  checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE health_probes IS 'Single-row target used by the readiness write probe';

-- Token accounting, one row per model call.
--
-- The provider reports real token counts but no history, and platform log
-- windows do not go back far enough to answer "is the prompt growing?". This
-- table makes that question answerable from data. The component columns are
-- shares of prompt_tokens, so system + tools + messages = prompt_tokens, which
-- is what shows whether memory or the tool schemas are responsible.
CREATE TABLE IF NOT EXISTS token_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  system_tokens INTEGER NOT NULL DEFAULT 0,
  tools_tokens INTEGER NOT NULL DEFAULT 0,
  messages_tokens INTEGER NOT NULL DEFAULT 0,
  /** Which pass through the tool loop this call was (0 = first). */
  iteration SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE token_usage IS 'Per-call token accounting, for watching prompt growth over time';

-- The reporting query: recent usage for one user, newest first.
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_id_cursor ON token_usage(user_id, id);

-- Each due date is a separate actionable item. The series advances when an
-- occurrence is materialized, while earlier occurrences remain actionable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_id_owner ON reminders(id, user_id);
CREATE TABLE IF NOT EXISTS reminder_occurrences (
  id BIGSERIAL PRIMARY KEY,
  reminder_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','cancelled')),
  next_notification_at TIMESTAMPTZ,
  notification_kind TEXT NOT NULL DEFAULT 'initial' CHECK (notification_kind IN ('initial','snooze','followup')),
  last_notified_at TIMESTAMPTZ,
  notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
  follow_up_count INTEGER NOT NULL DEFAULT 0 CHECK (follow_up_count BETWEEN 0 AND 2),
  completed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  FOREIGN KEY (reminder_id, user_id) REFERENCES reminders(id, user_id) ON DELETE CASCADE,
  UNIQUE (reminder_id, scheduled_for),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status = 'pending' OR (next_notification_at IS NULL AND lease_token IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_reminder_occurrences_due ON reminder_occurrences(next_notification_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_reminder_occurrences_owner ON reminder_occurrences(user_id, scheduled_for) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS reminder_preferences (
  user_id BIGINT PRIMARY KEY CHECK (user_id > 0),
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  follow_ups_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK ((quiet_hours_start IS NULL AND quiet_hours_end IS NULL) OR
    (quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL
      AND quiet_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND quiet_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND quiet_hours_start <> quiet_hours_end))
);
CREATE TABLE IF NOT EXISTS reminder_followup_daily_usage (
  user_id BIGINT NOT NULL CHECK (user_id > 0),
  local_date DATE NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, local_date)
);

-- All functions are invoker-rights and granted only to service_role below.
-- The series lock serializes materialization and cancellation. Schedule CAS
-- prevents a previously read due row from undoing a user's schedule edit.
CREATE OR REPLACE FUNCTION materialize_reminder_occurrence(
  p_reminder_id BIGINT, p_user_id BIGINT, p_expected_next_run_at TIMESTAMPTZ,
  p_expected_frequency TEXT, p_expected_time_of_day TEXT,
  p_expected_day_of_week INTEGER, p_expected_day_of_month INTEGER,
  p_next_run_at TIMESTAMPTZ, p_now TIMESTAMPTZ
) RETURNS SETOF reminder_occurrences LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE series reminders%ROWTYPE; occurrence reminder_occurrences%ROWTYPE;
BEGIN
  IF p_now IS NULL OR (p_next_run_at IS NOT NULL AND p_next_run_at <= p_now) THEN
    RAISE EXCEPTION 'Reminder time must be in the future';
  END IF;
  SELECT * INTO series FROM reminders WHERE id = p_reminder_id AND user_id = p_user_id AND active
    AND next_run_at = p_expected_next_run_at AND next_run_at <= p_now
    AND frequency = p_expected_frequency
    AND time_of_day IS NOT DISTINCT FROM p_expected_time_of_day
    AND day_of_week IS NOT DISTINCT FROM p_expected_day_of_week
    AND day_of_month IS NOT DISTINCT FROM p_expected_day_of_month FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF series.frequency = 'once' AND p_next_run_at IS NOT NULL THEN RAISE EXCEPTION 'One-off reminders cannot recur'; END IF;
  INSERT INTO reminder_occurrences(reminder_id,user_id,text,scheduled_for,next_notification_at)
    VALUES(series.id,series.user_id,series.text,series.next_run_at,series.next_run_at)
    ON CONFLICT (reminder_id,scheduled_for) DO NOTHING RETURNING * INTO occurrence;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE reminders SET active = p_next_run_at IS NOT NULL, next_run_at = COALESCE(p_next_run_at,next_run_at) WHERE id = series.id;
  RETURN NEXT occurrence;
END $$;

CREATE OR REPLACE FUNCTION claim_reminder_occurrence(
  p_id BIGINT, p_version INTEGER, p_now TIMESTAMPTZ, p_lease_until TIMESTAMPTZ, p_token TEXT
) RETURNS SETOF reminder_occurrences LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF p_now IS NULL OR p_lease_until IS NULL OR p_lease_until <= p_now OR p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'A delivery lease requires a future expiry and token';
  END IF;
  RETURN QUERY UPDATE reminder_occurrences SET lease_token = p_token, lease_until = p_lease_until
    WHERE id = p_id AND version = p_version AND status = 'pending' AND next_notification_at <= p_now
      AND (lease_until IS NULL OR lease_until <= p_now)
      AND (notification_kind <> 'followup' OR follow_up_count < 2)
    RETURNING *;
END $$;

CREATE OR REPLACE FUNCTION act_on_reminder_occurrence(
  p_id BIGINT, p_user_id BIGINT, p_version INTEGER, p_action TEXT, p_now TIMESTAMPTZ, p_snooze_until TIMESTAMPTZ
) RETURNS SETOF reminder_occurrences LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF p_now IS NULL OR p_action IS NULL OR p_action NOT IN ('done','skip','snooze') THEN RAISE EXCEPTION 'Invalid reminder action'; END IF;
  IF p_action = 'snooze' AND (p_snooze_until IS NULL OR p_snooze_until <= p_now) THEN RAISE EXCEPTION 'Snooze must be in the future'; END IF;
  RETURN QUERY UPDATE reminder_occurrences SET
    status = CASE p_action WHEN 'done' THEN 'done' WHEN 'skip' THEN 'skipped' ELSE 'pending' END,
    next_notification_at = CASE WHEN p_action = 'snooze' THEN p_snooze_until ELSE NULL END,
    notification_kind = CASE WHEN p_action = 'snooze' THEN 'snooze' ELSE notification_kind END,
    completed_at = CASE WHEN p_action = 'snooze' THEN NULL ELSE p_now END,
    version = version + 1, lease_token = NULL, lease_until = NULL
    WHERE id = p_id AND user_id = p_user_id AND version = p_version AND status = 'pending' RETURNING *;
END $$;

CREATE OR REPLACE FUNCTION finish_reminder_occurrence(
  p_id BIGINT, p_version INTEGER, p_token TEXT, p_sent_at TIMESTAMPTZ, p_next_notification_at TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE item reminder_occurrences%ROWTYPE; enabled BOOLEAN;
BEGIN
  IF p_sent_at IS NULL OR (p_next_notification_at IS NOT NULL AND p_next_notification_at <= p_sent_at) THEN RAISE EXCEPTION 'Follow-up must be in the future'; END IF;
  SELECT * INTO item FROM reminder_occurrences WHERE id = p_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  -- Keep lock order series -> preferences -> occurrence. This avoids deadlocks
  -- with cancellation and makes opting out win over an in-flight send.
  PERFORM 1 FROM reminders WHERE id = item.reminder_id FOR UPDATE;
  INSERT INTO reminder_preferences(user_id) VALUES(item.user_id) ON CONFLICT DO NOTHING;
  SELECT follow_ups_enabled INTO enabled FROM reminder_preferences WHERE user_id = item.user_id FOR UPDATE;
  UPDATE reminder_occurrences SET last_notified_at = p_sent_at,
    notification_count = notification_count + 1,
    follow_up_count = follow_up_count + CASE WHEN notification_kind = 'followup' THEN 1 ELSE 0 END,
    next_notification_at = CASE WHEN enabled AND (follow_up_count + CASE WHEN notification_kind = 'followup' THEN 1 ELSE 0 END) < 2 THEN p_next_notification_at ELSE NULL END,
    notification_kind = 'followup', lease_token = NULL, lease_until = NULL
    WHERE id = p_id AND version = p_version AND lease_token = p_token AND status = 'pending';
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE reminders SET last_sent_at = GREATEST(last_sent_at,p_sent_at) WHERE id = item.reminder_id;
  RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION defer_reminder_occurrence(p_id BIGINT, p_version INTEGER, p_token TEXT, p_until TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE owner_id BIGINT; enabled BOOLEAN;
BEGIN
  SELECT user_id INTO owner_id FROM reminder_occurrences WHERE id = p_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  INSERT INTO reminder_preferences(user_id) VALUES(owner_id) ON CONFLICT DO NOTHING;
  SELECT follow_ups_enabled INTO enabled FROM reminder_preferences WHERE user_id = owner_id FOR UPDATE;
  UPDATE reminder_occurrences SET next_notification_at = CASE WHEN notification_kind = 'followup' AND NOT enabled THEN NULL ELSE p_until END,
    lease_token = NULL, lease_until = NULL
    WHERE id = p_id AND version = p_version AND lease_token = p_token AND status = 'pending';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION cancel_reminder_occurrences(p_reminder_id BIGINT, p_user_id BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE was_active BOOLEAN; changed BOOLEAN;
BEGIN
  SELECT active INTO was_active FROM reminders WHERE id = p_reminder_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE reminders SET active = FALSE WHERE id = p_reminder_id;
  UPDATE reminder_occurrences SET status = 'cancelled', next_notification_at = NULL,
    version = version + 1, lease_token = NULL, lease_until = NULL
    WHERE reminder_id = p_reminder_id AND user_id = p_user_id AND status = 'pending';
  changed := FOUND;
  RETURN was_active OR changed;
END $$;

CREATE OR REPLACE FUNCTION update_reminder_preferences(p_user_id BIGINT, p_patch JSONB)
RETURNS SETOF reminder_preferences LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE prefs reminder_preferences%ROWTYPE;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object'
    OR p_patch - ARRAY['quiet_hours_start','quiet_hours_end','follow_ups_enabled'] <> '{}'::jsonb
    OR (p_patch ? 'follow_ups_enabled' AND jsonb_typeof(p_patch->'follow_ups_enabled') <> 'boolean')
    OR (p_patch ? 'quiet_hours_start' AND jsonb_typeof(p_patch->'quiet_hours_start') NOT IN ('string','null'))
    OR (p_patch ? 'quiet_hours_end' AND jsonb_typeof(p_patch->'quiet_hours_end') NOT IN ('string','null'))
  THEN RAISE EXCEPTION 'Invalid reminder preferences'; END IF;
  INSERT INTO reminder_preferences(user_id) VALUES(p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO prefs FROM reminder_preferences WHERE user_id = p_user_id FOR UPDATE;
  UPDATE reminder_preferences SET
    quiet_hours_start = CASE WHEN p_patch ? 'quiet_hours_start' THEN p_patch->>'quiet_hours_start' ELSE quiet_hours_start END,
    quiet_hours_end = CASE WHEN p_patch ? 'quiet_hours_end' THEN p_patch->>'quiet_hours_end' ELSE quiet_hours_end END,
    follow_ups_enabled = CASE WHEN p_patch ? 'follow_ups_enabled' THEN (p_patch->>'follow_ups_enabled')::boolean ELSE follow_ups_enabled END
    WHERE user_id = p_user_id RETURNING * INTO prefs;
  IF NOT prefs.follow_ups_enabled THEN
    UPDATE reminder_occurrences SET next_notification_at = NULL, lease_token = NULL, lease_until = NULL
      WHERE user_id = p_user_id AND status = 'pending' AND notification_kind = 'followup';
  END IF;
  RETURN NEXT prefs;
END $$;

CREATE OR REPLACE FUNCTION reserve_reminder_follow_up(p_user_id BIGINT, p_local_date DATE, p_maximum INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF p_maximum IS NULL OR p_maximum NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Follow-up maximum must be between 1 and 5'; END IF;
  INSERT INTO reminder_followup_daily_usage(user_id,local_date,attempts) VALUES(p_user_id,p_local_date,1)
    ON CONFLICT (user_id,local_date) DO UPDATE SET attempts = reminder_followup_daily_usage.attempts + 1
      WHERE reminder_followup_daily_usage.attempts < p_maximum;
  RETURN FOUND;
END $$;

-- ============================================================
-- Row Level Security
-- ============================================================
-- These tables hold private conversations and secrets, so they are closed to
-- the public key entirely. The bot reaches them with SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS. Explicit policies document that intent and mean the same
-- migration also works on a project where RLS was already enabled by hand.

ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_followup_daily_usage ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
  client_role TEXT;
  sequence_name TEXT;
BEGIN
  -- The service_role is created by Supabase. A plain Postgres instance (used
  -- for local testing) will not have it, so skip policy creation there rather
  -- than failing the whole migration. On Supabase, service_role also carries
  -- BYPASSRLS, so these policies are belt-and-braces documentation of intent.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE 'role service_role not found; skipping RLS policies (expected outside Supabase)';
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA public TO service_role;

  FOREACH target IN ARRAY ARRAY['user_data', 'command_history', 'tasks', 'prompts', 'conversations', 'facts', 'reminders', 'pending_actions', 'credentials', 'health_probes', 'token_usage', 'reminder_occurrences', 'reminder_preferences', 'reminder_followup_daily_usage']
  LOOP
    -- The bot enforces Telegram ownership with a server-only service key.
    -- Remove legacy API grants as well as enabling RLS so an old permissive
    -- policy cannot accidentally reopen private data during this upgrade.
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target);
    FOR client_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target, client_role);
    END LOOP;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', target);

    sequence_name := CASE WHEN target IN ('user_data','reminder_preferences','reminder_followup_daily_usage') THEN NULL ELSE pg_get_serial_sequence(format('public.%I', target), 'id') END;
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', sequence_name);
      FOR client_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
      LOOP
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', sequence_name, client_role);
      END LOOP;
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', sequence_name);
    END IF;

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

-- Functions default to PUBLIC execution in PostgreSQL; revoke that even on
-- non-Supabase installations and remove inherited API-role grants on upgrades.
DO $$
DECLARE target REGPROCEDURE; client_role TEXT;
BEGIN
  FOR target IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('materialize_reminder_occurrence','claim_reminder_occurrence','act_on_reminder_occurrence',
      'finish_reminder_occurrence','defer_reminder_occurrence','cancel_reminder_occurrences',
      'update_reminder_preferences','reserve_reminder_follow_up')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',target);
    FOR client_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',target,client_role);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',target);
    END IF;
  END LOOP;
END $$;

-- Verification queries
-- Run these to verify your tables were created successfully:

-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- SELECT * FROM user_data LIMIT 5;
-- SELECT * FROM command_history ORDER BY created_at DESC LIMIT 10;
-- SELECT id, title, tags FROM prompts ORDER BY created_at DESC LIMIT 10;
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('user_data','command_history','tasks','prompts','conversations','facts','reminders','pending_actions','credentials','health_probes','token_usage');
