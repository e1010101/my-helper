/**
 * Preflight: verifies everything the deployed bot needs, before or after
 * deploying. Catches a bad variable, a wrong key or an unreachable dependency
 * here rather than as a crash loop in the Railway logs.
 *
 * Read-only against your data: the database check performs the same
 * insert-then-delete write probe the health check uses.
 *
 * Usage: npm run preflight
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader, matching scripts/db-migrate.ts. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

// Real environment wins; .env fills the gaps. Same precedence as dotenv.
const fileEnv = readEnvFile(join(projectRoot, '.env'));
for (const [key, value] of Object.entries(fileEnv)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

const checks: Check[] = [];
const redact = (value: string) => `${value.slice(0, 8)}…(${value.length} chars)`;

function record(name: string, status: Check['status'], detail: string): void {
  checks.push({ name, status, detail });
}

// --- Required variables ----------------------------------------------------

const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_USER_ID',
] as const;

for (const key of REQUIRED) {
  const value = process.env[key];
  if (!value) {
    record(key, 'fail', 'missing');
  } else if (/^(your_|\[|<)/.test(value)) {
    record(key, 'fail', `still the placeholder value: ${value.slice(0, 24)}`);
  } else {
    record(key, 'ok', redact(value));
  }
}

// --- Provider configuration ------------------------------------------------

let providerName: string | null = null;
try {
  const { env } = await import('../src/config/env.js');
  providerName = env.aiProvider();
  const model = providerName === 'deepseek' ? env.deepseek().model : 'gemini-2.5-flash';
  record('AI provider', 'ok', `${providerName} (${model})`);
} catch (error) {
  record('AI provider', 'fail', error instanceof Error ? error.message : String(error));
}

// --- Telegram --------------------------------------------------------------

const token = process.env.TELEGRAM_BOT_TOKEN;
if (token && !/^(your_|\[|<)/.test(token)) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: { username?: string; id?: number };
    };

    if (body.ok) {
      record('Telegram', 'ok', `@${body.result?.username} (id ${body.result?.id})`);

      // A registered webhook and polling are mutually exclusive.
      const hook = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json() as Promise<{ result?: { url?: string; pending_update_count?: number } }>);

      const url = hook.result?.url;
      record(
        'Telegram webhook',
        'ok',
        url ? `${url} (pending: ${hook.result?.pending_update_count ?? 0})` : 'not set — polling mode'
      );
    } else {
      record('Telegram', 'fail', `token rejected: ${body.description ?? 'unknown error'}`);
    }
  } catch (error) {
    record('Telegram', 'fail', `unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Supabase: tables, RLS and writability ---------------------------------

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (supabaseUrl && serviceKey && !/^(your_|\[|<)/.test(supabaseUrl)) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(supabaseUrl, serviceKey);
    const anon = anonKey ? createClient(supabaseUrl, anonKey) : null;

    const REQUIRED_TABLES = [
      'user_data',
      'command_history',
      'tasks',
      'prompts',
      'conversations',
      'facts',
      'reminders',
      'pending_actions',
      'credentials',
      'health_probes',
      'token_usage',
    ];

    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      const { error } = await admin.from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) {
        missing.push(`${table} (${error.message})`);
      }
    }

    if (missing.length > 0) {
      record('Supabase tables', 'fail', `missing or unreadable: ${missing.join('; ')}`);
    } else {
      record('Supabase tables', 'ok', `all ${REQUIRED_TABLES.length} present`);
    }

    // A read cannot detect the RLS misconfiguration; a write can.
    const PROBE_USER = -1;
    const { error: writeError } = await admin
      .from('conversations')
      .insert({ user_id: PROBE_USER, role: 'user', content: 'preflight probe' });

    if (writeError) {
      const hint = /permission denied|row-level security|violates row-level/i.test(writeError.message)
        ? ' — SUPABASE_SERVICE_ROLE_KEY looks wrong (an anon key cannot write here)'
        : '';
      record('Supabase write probe', 'fail', `${writeError.message}${hint}`);
    } else {
      await admin.from('conversations').delete().eq('user_id', PROBE_USER);
      record('Supabase write probe', 'ok', 'service role can write RLS-protected tables');
    }

    if (anon) {
      const { error: anonError } = await anon
        .from('conversations')
        .insert({ user_id: PROBE_USER, role: 'user', content: 'should be rejected' });
      if (anonError) {
        record('Row Level Security', 'ok', `anon key correctly refused: ${anonError.message.slice(0, 60)}`);
      } else {
        await anon.from('conversations').delete().eq('user_id', PROBE_USER);
        record('Row Level Security', 'fail', 'the anon key could write — RLS is NOT protecting your data');
      }
    }
  } catch (error) {
    record('Supabase', 'fail', `unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Model provider --------------------------------------------------------

if (providerName) {
  try {
    const { createAIClient } = await import('../src/services/ai-provider.js');
    const client = createAIClient();
    const reply = await client.generateText(
      'Reply with exactly: PREFLIGHT_OK',
      'You are a health check. Reply with exactly the text requested and nothing else.'
    );
    const clean = reply.trim();
    if (/PREFLIGHT_OK/i.test(clean)) {
      record('Model provider', 'ok', `answered: ${clean.slice(0, 40)}`);
    } else {
      record('Model provider', 'warn', `replied but not as instructed: ${clean.slice(0, 80)}`);
    }
  } catch (error) {
    record('Model provider', 'fail', error instanceof Error ? error.message : String(error));
  }
}

// --- Timezone and owner ----------------------------------------------------

const timezone = process.env.TIMEZONE;
if (!timezone) {
  record('TIMEZONE', 'warn', 'unset — falling back to the host timezone');
} else {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date());
    record('TIMEZONE', 'ok', timezone);
  } catch {
    record('TIMEZONE', 'fail', `"${timezone}" is not a valid IANA timezone`);
  }
}

const adminId = process.env.ADMIN_USER_ID;
if (adminId && /^\d+$/.test(adminId.split(',')[0].trim())) {
  record('Reminder delivery', 'ok', `scheduler will deliver to chat ${adminId.split(',')[0].trim()}`);
} else if (adminId) {
  record('Reminder delivery', 'fail',`ADMIN_USER_ID is not a numeric Telegram id: ${adminId}`);
} else {
  record('Reminder delivery', 'fail', 'ADMIN_USER_ID unset — the scheduler will not start');
}

// --- Report ----------------------------------------------------------------

const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' } as const;
const width = Math.max(...checks.map((check) => check.name.length));

console.log('\n🔎 Preflight\n');
for (const check of checks) {
  console.log(`  ${icon[check.status]} ${check.name.padEnd(width)}  ${check.detail}`);
}

const failures = checks.filter((check) => check.status === 'fail');
const warnings = checks.filter((check) => check.status === 'warn');

console.log('');
if (failures.length === 0) {
  console.log(`✅ All checks passed${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}.`);
  console.log('   Set these same variables on Railway, then deploy.\n');
} else {
  console.log(`❌ ${failures.length} check(s) failed — fix these before deploying:\n`);
  for (const failure of failures) {
    console.log(`   • ${failure.name}: ${failure.detail}`);
  }
  console.log('');
  process.exit(1);
}
