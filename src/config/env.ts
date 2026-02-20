import dotenv from 'dotenv';

dotenv.config();

interface Config {
  telegram: {
    token: string;
  };
  supabase: {
    url: string;
    anonKey?: string;
    serviceRoleKey?: string;
  };
  webhook?: {
    domain: string;
    port: number;
  };
  nodeEnv: string;
}

function getEnvVar(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getOptionalEnvVar(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() ? value : undefined;
}

function getSupabaseKeys(): { anonKey?: string; serviceRoleKey?: string } {
  const anonKey = getOptionalEnvVar('SUPABASE_ANON_KEY');
  const serviceRoleKey = getOptionalEnvVar('SUPABASE_SERVICE_ROLE_KEY');

  if (!anonKey && !serviceRoleKey) {
    throw new Error('Missing Supabase credentials: set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
  }

  return { anonKey, serviceRoleKey };
}

const supabaseKeys = getSupabaseKeys();

export const config: Config = {
  telegram: {
    token: getEnvVar('TELEGRAM_BOT_TOKEN'),
  },
  supabase: {
    url: getEnvVar('SUPABASE_URL'),
    anonKey: supabaseKeys.anonKey,
    serviceRoleKey: supabaseKeys.serviceRoleKey,
  },
  webhook: process.env.WEBHOOK_DOMAIN
    ? {
        domain: process.env.WEBHOOK_DOMAIN,
        port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
      }
    : undefined,
  nodeEnv: process.env.NODE_ENV || 'development',
};
