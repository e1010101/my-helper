/**
 * Verifies a deployed instance against its public URL.
 *
 * Everything the objective needs to confirm about a live deployment is
 * observable from outside: the two health endpoints, and whether Telegram is
 * actually pointed at this instance with the secret configured. Reminder
 * delivery itself is not observable via the Bot API, so that stays a manual
 * step.
 *
 * Usage: npm run verify:deploy https://your-app.up.railway.app
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
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

const fileEnv = readEnvFile(join(projectRoot, '.env'));
const token = process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN;

const rawTarget = process.argv[2];
if (!rawTarget) {
  console.error('\n❌ Provide the deployed base URL.\n');
  console.error('   Usage: npm run verify:deploy https://your-app.up.railway.app\n');
  process.exit(1);
}

const target = rawTarget.replace(/\/+$/, '');
const targetHost = new URL(target).host;

interface Result {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

const results: Result[] = [];
const record = (name: string, status: Result['status'], detail: string) =>
  results.push({ name, status, detail });

interface HealthBody {
  status?: string;
  check?: string;
  bot?: { connected?: boolean; mode?: string };
  database?: { connected?: boolean; latency?: number; error?: string };
}

async function probe(path: string): Promise<{ code: number; body: HealthBody | null }> {
  try {
    const response = await fetch(`${target}${path}`, { signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    try {
      return { code: response.status, body: JSON.parse(text) as HealthBody };
    } catch {
      return { code: response.status, body: null };
    }
  } catch (error) {
    record(path, 'fail', `unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 0, body: null };
  }
}

console.log(`\n🔎 Verifying ${target}\n`);

// --- Health endpoints ------------------------------------------------------

const health = await probe('/health');
if (health.code !== 0) {
  if (health.code === 200) {
    record('/health', 'ok', `HTTP 200, bot connected=${health.body?.bot?.connected}, mode=${health.body?.bot?.mode}`);
  } else {
    record(
      '/health',
      'fail',
      `HTTP ${health.code} — the platform healthcheck will not pass. ${health.body?.bot?.connected === false ? 'Telegram is unreachable with this token.' : ''}`
    );
  }
}

const ready = await probe('/ready');
if (ready.code !== 0) {
  if (ready.code === 200) {
    record('/ready', 'ok', `HTTP 200, database ok (${ready.body?.database?.latency ?? '?'}ms)`);
  } else {
    record(
      '/ready',
      'fail',
      `HTTP ${ready.code}${ready.body?.database?.error ? ` — ${ready.body.database.error}` : ''}`
    );
  }
}

// --- Telegram wiring -------------------------------------------------------

if (!token) {
  record('Telegram', 'warn', 'no TELEGRAM_BOT_TOKEN available locally to check wiring');
} else {
  try {
    const hook = (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(20_000),
    }).then((r) => r.json())) as {
      ok: boolean;
      description?: string;
      result?: { url?: string; pending_update_count?: number; last_error_message?: string };
    };

    if (!hook.ok) {
      record('Telegram', 'fail', `token rejected: ${hook.description ?? 'unknown error'}`);
    } else {
      const url = hook.result?.url ?? '';
      const mode = health.body?.bot?.mode;

      if (!url) {
        // Cross-reference what /health reported: in webhook mode an unset URL
        // means registration failed, which is a very different problem from
        // simply running in polling mode.
        if (mode === 'webhook') {
          record(
            'Webhook',
            'fail',
            'not registered, but the instance reports webhook mode — setWebhook failed or was never called'
          );
        } else {
          record('Webhook', 'ok', 'not set — instance is in polling mode');
        }
      } else if (!url.includes(targetHost)) {
        record('Webhook', 'fail', `points at ${url}, not this deployment (${targetHost})`);
      } else {
        record('Webhook', 'ok', url);
      }

      if (hook.result?.last_error_message) {
        record('Webhook delivery', 'fail', hook.result.last_error_message);
      } else {
        record('Webhook delivery', 'ok', `no delivery errors, pending: ${hook.result?.pending_update_count ?? 0}`);
      }
    }
  } catch (error) {
    record('Telegram', 'warn', `could not check: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Report ----------------------------------------------------------------

const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' } as const;
const width = Math.max(...results.map((r) => r.name.length));

for (const result of results) {
  console.log(`  ${icon[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
}

const failures = results.filter((r) => r.status === 'fail');
console.log('');

if (failures.length === 0) {
  console.log('✅ Deployed instance looks healthy.');
  console.log('\nLast step, which cannot be automated: send your bot');
  console.log('  "remind me to test this in 2 minutes"');
  console.log('tap Confirm, and check the alarm arrives on its own.\n');
} else {
  console.log(`❌ ${failures.length} check(s) failed.\n`);
  process.exit(1);
}
