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

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_command_history_user_id ON command_history(user_id);
CREATE INDEX IF NOT EXISTS idx_command_history_created_at ON command_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_history_command ON command_history(command);

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

-- Verification queries
-- Run these to verify your tables were created successfully:

-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- SELECT * FROM user_data LIMIT 5;
-- SELECT * FROM command_history ORDER BY created_at DESC LIMIT 10;
