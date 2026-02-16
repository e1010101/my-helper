import dotenv from 'dotenv';

dotenv.config();

interface Config {
  telegram: {
    token: string;
  };
  supabase: {
    url: string;
    anonKey: string;
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

export const config: Config = {
  telegram: {
    token: getEnvVar('TELEGRAM_BOT_TOKEN'),
  },
  supabase: {
    url: getEnvVar('SUPABASE_URL'),
    anonKey: getEnvVar('SUPABASE_ANON_KEY'),
  },
  webhook: process.env.WEBHOOK_DOMAIN
    ? {
        domain: process.env.WEBHOOK_DOMAIN,
        port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
      }
    : undefined,
  nodeEnv: process.env.NODE_ENV || 'development',
};
