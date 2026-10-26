import assert from 'node:assert/strict';
import { after } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// Test processes must never pick up provider credentials from a developer's
// shell or .env. Individual tests may replace these with their own fixtures.
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123456:TEST_ONLY',
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  AI_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'test-provider-key',
  GEMINI_API_KEY: '',
  WEBHOOK_DOMAIN: '',
  WEBHOOK_SECRET: '',
});

const blocked: string[] = [];
function requireLoopback(hostname: string): void {
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) return;
  // Record attempts as well as throwing: application error handling must not
  // turn an accidental live request into a passing test.
  blocked.push(hostname);
  throw new Error(`External network disabled in tests: ${hostname}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  requireLoopback(url.hostname);
  return realFetch(input, init);
};

// Telegraf uses node-fetch rather than global fetch. Guard both HTTP APIs so
// an omitted Telegram mock cannot accidentally contact a real bot either.
for (const client of [http, https]) {
  for (const method of ['request', 'get'] as const) {
    const original = client[method];
    const guarded = (...args: unknown[]) => {
      const first = args[0];
      const hostname = typeof first === 'string' || first instanceof URL
        ? new URL(first).hostname
        : String((first as http.RequestOptions | undefined)?.hostname
          ?? (first as http.RequestOptions | undefined)?.host ?? 'localhost');
      requireLoopback(hostname);
      return Reflect.apply(original, client, args);
    };
    client[method] = guarded as typeof original;
  }
}
syncBuiltinESMExports();

after(() => {
  assert.deepEqual(blocked, [], 'Unexpected external network request(s) escaped the test mocks');
});
