import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import type { Reminder } from '../src/types/assistant.js';
import { groupUsageByDay } from '../src/services/token-usage.js';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'test-only';
const { SupabaseAssistantStore } = await import('../src/services/supabase-assistant-store.js');

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

test('persistent confirmation consumption is one owner-scoped DELETE returning the claimed action', async () => {
  const requests: { method: string; url: URL }[] = [];
  let row: Record<string, unknown> | null = {
    id: 7, user_id: 1, tool_name: 'save_fact', args: { key: 'a', value: 'b' }, model_parts: [],
    requested_at: '2026-10-26T15:59:50Z', created_at: '2026-10-26T16:00:10Z', expires_at: '2026-10-26T16:09:50Z',
  };
  const client = createClient('https://example.invalid', 'test-key', {
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? 'GET', url });
      assert.equal(init?.method, 'DELETE', 'a read followed by delete would race');
      if (!row || url.searchParams.get('id') !== `eq.${row.id}` || url.searchParams.get('user_id') !== `eq.${row.user_id}`) return json(null);
      const claimed = row;
      row = null; // Atomic DELETE RETURNING behavior at the server boundary.
      return json(claimed);
    } },
  });
  const firstProcess = new SupabaseAssistantStore(client);
  const secondProcess = new SupabaseAssistantStore(client);
  assert.equal(await firstProcess.consumePendingAction(7, 99), null, 'another user cannot consume it');
  const claims = await Promise.all([firstProcess.consumePendingAction(7, 1), secondProcess.consumePendingAction(7, 1)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.requestedAt, '2026-10-26T15:59:50Z');
  assert.equal(requests.length, 3);
});

test('persistent proposals retain request time separately from database insertion time', async () => {
  const client = createClient('https://example.invalid', 'test-key', {
    global: { fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.requested_at, '2026-10-26T15:59:50Z');
      return json({ ...body, id: 7, created_at: '2026-10-26T16:00:10Z' });
    } },
  });
  const saved = await new SupabaseAssistantStore(client).createPendingAction({
    userId: 1, toolName: 'save_fact', args: {}, modelParts: [],
    requestedAt: '2026-10-26T15:59:50Z', expiresAt: '2026-10-26T16:09:50Z',
  });
  assert.equal(saved.requestedAt, '2026-10-26T15:59:50Z');
  assert.equal(saved.createdAt, '2026-10-26T16:00:10Z');
});

test('persistent delivery writes compare the full schedule but allow text-only edits', async () => {
  const expected: Reminder = {
    id: 3, userId: 1, text: 'Old text', nextRunAt: '2026-10-27T01:00:00Z', frequency: 'daily',
    timeOfDay: '09:00', dayOfWeek: null, dayOfMonth: null, active: true, lastSentAt: null, createdAt: '2026-10-26T00:00:00Z',
  };
  const row: Record<string, unknown> = {
    id: 3, user_id: 1, text: 'New text', next_run_at: expected.nextRunAt, frequency: 'daily',
    time_of_day: '09:00', day_of_week: null, day_of_month: null, active: true, last_sent_at: null,
  };
  let lastQuery: URL | undefined;
  const client = createClient('https://example.invalid', 'test-key', {
    global: { fetch: async (input, init) => {
      lastQuery = new URL(String(input));
      const matches = [...lastQuery.searchParams.entries()].every(([key, value]) => {
        if (value === 'is.null') return row[key] === null;
        if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
        return true;
      });
      if (matches) Object.assign(row, JSON.parse(String(init?.body)));
      return json(null);
    } },
  });
  const store = new SupabaseAssistantStore(client);
  await store.markReminderSent(3, '2026-10-28T01:00:00Z', '2026-10-27T01:00:00Z', expected);
  assert.equal(row.text, 'New text');
  assert.equal(row.next_run_at, '2026-10-28T01:00:00Z');
  assert.equal(lastQuery?.searchParams.get('user_id'), 'eq.1');
  assert.equal(lastQuery?.searchParams.get('active'), 'eq.true');
  assert.equal(lastQuery?.searchParams.get('time_of_day'), 'eq.09:00');
  assert.equal(lastQuery?.searchParams.get('day_of_week'), 'is.null');
  row.next_run_at = expected.nextRunAt;
  row.frequency = 'weekly';
  row.day_of_week = 1;
  await store.completeReminder(3, '2026-10-27T01:00:00Z', expected);
  assert.equal(row.active, true, 'changed schedule cannot be completed by stale delivery');
  row.frequency = expected.frequency;
  row.day_of_week = null;
  row.active = false;
  await store.markReminderSent(3, '2026-10-28T01:00:00Z', '2026-10-27T01:00:00Z', expected);
  assert.equal(row.next_run_at, expected.nextRunAt, 'cancelled occurrence stays untouched');
});

test('usage summaries include more than 5000 calls despite a smaller server page cap', async () => {
  const now = Date.now();
  const rows = Array.from({ length: 6005 }, (_, index) => ({
    id: index + 1, user_id: 1, prompt_tokens: 101, completion_tokens: 7, total_tokens: 108, cached_tokens: 11,
    system_tokens: 20, tools_tokens: 30, messages_tokens: 51,
    created_at: new Date(now - (6005 - index) * 60_000).toISOString(),
  }));
  const snapshot = structuredClone(rows);
  let requestedPages = 0;
  let tailAdded = false;
  const client = createClient('https://example.invalid', 'test-key', {
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('user_id'), 'eq.1');
      let page = rows.filter((row) => row.created_at >= url.searchParams.get('created_at')!.slice(4));
      for (const filter of url.searchParams.getAll('id')) {
        if (filter.startsWith('gt.')) page = page.filter((row) => row.id > Number(filter.slice(3)));
        if (filter.startsWith('lte.')) page = page.filter((row) => row.id <= Number(filter.slice(4)));
      }
      page = page.sort((a, b) => url.searchParams.get('order') === 'id.desc' ? b.id - a.id : a.id - b.id);
      const limit = Number(url.searchParams.get('limit'));
      page = page.slice(0, Math.min(limit, 37)); // Lower than both requested page size and normal Supabase cap.
      if (url.searchParams.get('select') === 'id') return json(page.map((row) => ({ id: row.id })));
      requestedPages += 1;
      if (!tailAdded) {
        rows.push({ ...rows[rows.length - 1], id: 6006, created_at: new Date(now).toISOString() });
        tailAdded = true;
      }
      return json(page);
    } },
  });
  const store = new SupabaseAssistantStore(client);
  const summary = await store.summariseTokenUsage(1, new Date(now - 10 * 86_400_000));
  assert.equal(summary.calls, 6005, 'the report has a fixed upper ID, excluding calls inserted during pagination');
  assert.equal(summary.promptTokens, 6005 * 101);
  assert.equal(summary.totalTokens, 6005 * 108);
  assert.equal(summary.firstRecordedAt, snapshot[0].created_at);
  assert.equal(summary.lastRecordedAt, snapshot[snapshot.length - 1].created_at);
  assert.ok(requestedPages > 100, 'short server pages do not end the report early');

  const daily = await store.dailyTokenUsage(1, 10, 'Asia/Singapore');
  const expected = groupUsageByDay(rows.map((row) => ({
    createdAt: row.created_at, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens, cachedTokens: row.cached_tokens, systemTokens: row.system_tokens,
    toolsTokens: row.tools_tokens, messagesTokens: row.messages_tokens,
  })), 'Asia/Singapore');
  assert.deepEqual(daily, expected, 'all daily totals and averages agree with the complete snapshot');
});
