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
  groq: {
    apiKey: string;
    personalityPrompt: string;
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
  groq: {
    apiKey: getEnvVar('GROQ_API_KEY'),
    personalityPrompt: process.env.BOT_PERSONALITY_PROMPT || 'You are a helpful and friendly personal assistant bot for Telegram. Provide concise and useful answers.',
  },
  webhook: process.env.WEBHOOK_DOMAIN
    ? {
      domain: process.env.WEBHOOK_DOMAIN,
      port: parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10),
    }
    : undefined,
  nodeEnv: process.env.NODE_ENV || 'development',
};
