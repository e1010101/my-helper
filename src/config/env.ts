import dotenv from 'dotenv';

dotenv.config();

export interface TelegramConfig {
  token: string;
}

export interface SupabaseConfig {
  url: string;
  /** Public key. Safe to expose, honours Row Level Security. */
  anonKey: string;
  /**
   * Secret key. Bypasses RLS, so it is only used server-side to reach the
   * locked-down tables (credentials, conversations, facts, reminders).
   * Optional at boot so a missing key surfaces as an actionable health error
   * rather than a crash.
   */
  serviceRoleKey?: string;
}

export interface GeminiConfig {
  apiKey: string;
  personalityPrompt: string;
}

export interface WebhookConfig {
  domain: string;
  port: number;
  secretToken?: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_PERSONALITY =
  'You are a helpful and friendly personal assistant bot for Telegram. Provide concise and useful answers.';

function getEnvVar(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Resolves a port from an optional environment variable, falling back to the
 * next candidate. Hosting platforms (Railway, Heroku, Fly) inject PORT, so it
 * takes precedence over the project-specific WEBHOOK_PORT.
 */
function resolvePort(...candidates: (string | undefined)[]): number {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
}

function resolveTimezone(): string {
  const configured = process.env.TIMEZONE?.trim();
  if (configured) {
    return configured;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Environment access is lazy on purpose: reading configuration is what
 * validates it, so modules can be imported by tests and tooling without a
 * fully populated environment.
 */
export const env = {
  telegram(): TelegramConfig {
    return { token: getEnvVar('TELEGRAM_BOT_TOKEN') };
  },

  supabase(): SupabaseConfig {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    return {
      url: getEnvVar('SUPABASE_URL'),
      anonKey: getEnvVar('SUPABASE_ANON_KEY'),
      serviceRoleKey: serviceRoleKey || undefined,
    };
  },

  gemini(): GeminiConfig {
    return {
      apiKey: getEnvVar('GEMINI_API_KEY'),
      personalityPrompt: process.env.BOT_PERSONALITY_PROMPT || DEFAULT_PERSONALITY,
    };
  },

  webhook(): WebhookConfig | undefined {
    const domain = process.env.WEBHOOK_DOMAIN?.trim();
    if (!domain) {
      return undefined;
    }
    return {
      domain,
      port: resolvePort(process.env.PORT, process.env.WEBHOOK_PORT),
      secretToken: process.env.WEBHOOK_SECRET?.trim() || undefined,
    };
  },

  /** Port for the standalone HTTP server used in polling mode. */
  port(): number {
    return resolvePort(process.env.PORT, process.env.WEBHOOK_PORT);
  },

  timezone(): string {
    return resolveTimezone();
  },

  nodeEnv(): string {
    return process.env.NODE_ENV || 'development';
  },

  isProduction(): boolean {
    return (process.env.NODE_ENV || 'development') === 'production';
  },
};
