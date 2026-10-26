import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Telegraf } from 'telegraf';
import { HealthService } from '../src/services/health.js';

type DatabaseStatus = { connected: boolean; latency?: number; error?: string };
type HealthInternals = { checkDatabaseHealth(signal: AbortSignal): Promise<DatabaseStatus> };

function service(callApi: (method: string, payload: unknown, options: { signal: AbortSignal }) => Promise<unknown>) {
  return new HealthService({ telegram: { callApi } } as unknown as Telegraf, { timeoutMs: 30 });
}

test('liveness never starts a database probe, even when it would hang', async () => {
  const health = service(async () => ({ id: 1 }));
  let databaseCalls = 0;
  (health as unknown as HealthInternals).checkDatabaseHealth = () => {
    databaseCalls++;
    return new Promise(() => {});
  };
  const result = await health.getHealthStatus({ checkDatabase: false });
  assert.equal(result.status, 'healthy');
  assert.equal(result.bot.connected, true);
  assert.equal(result.database.checked, false);
  assert.equal(databaseCalls, 0);
});

test('readiness returns unhealthy and cancels a stalled database probe', async () => {
  const health = service(async () => ({ id: 1 }));
  let databaseSignal: AbortSignal | undefined;
  (health as unknown as HealthInternals).checkDatabaseHealth = (signal) => {
    databaseSignal = signal;
    return new Promise(() => {});
  };
  const result = await health.getHealthStatus();
  assert.equal(result.status, 'unhealthy');
  assert.equal(result.bot.connected, true);
  assert.equal(result.database.checked, true);
  assert.match(result.database.error ?? '', /timed out/);
  assert.equal(databaseSignal?.aborted, true);
});

test('a stalled Telegram probe is also bounded and cancelled', async () => {
  let telegramSignal: AbortSignal | undefined;
  const health = service((_method, _payload, { signal }) => {
    telegramSignal = signal;
    return new Promise(() => {});
  });
  const result = await health.getHealthStatus({ checkDatabase: false });
  assert.equal(result.status, 'unhealthy');
  assert.equal(result.bot.connected, false);
  assert.equal(telegramSignal?.aborted, true);
});

test('readiness preserves healthy results and handles probe rejection', async () => {
  const health = service(async () => ({ id: 1 }));
  (health as unknown as HealthInternals).checkDatabaseHealth = async () => ({ connected: true, latency: 2 });
  assert.equal((await health.getHealthStatus()).status, 'healthy');
  (health as unknown as HealthInternals).checkDatabaseHealth = async () => { throw new Error('database unavailable'); };
  const result = await health.getHealthStatus();
  assert.equal(result.status, 'unhealthy');
  assert.match(result.database.error ?? '', /database unavailable/);
});
