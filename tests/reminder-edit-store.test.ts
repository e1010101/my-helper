import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'fake';
const { SupabaseAssistantStore } = await import('../src/services/supabase-assistant-store.js');

function fixture() {
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = [];
  const row = {
    id: 6, user_id: 4242, text: 'Daily report', active: true,
    next_run_at: '2099-10-05T14:00:00Z', frequency: 'daily', time_of_day: '22:00',
    day_of_week: null, day_of_month: null, last_sent_at: '2099-10-04T14:00:00Z', created_at: '2026-10-04T14:00:00Z',
  };
  let fail = false;
  const client: SupabaseClient = createClient('https://example.invalid', 'fake-key', {
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, method, body });
      if (fail) return new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), { status: 403 });
      const matches = url.searchParams.get('id') === `eq.${row.id}`
        && url.searchParams.get('user_id') === `eq.${row.user_id}`
        && url.searchParams.get('active') === 'eq.true' && row.active;
      if (matches && method === 'PATCH') Object.assign(row, body);
      return new Response(JSON.stringify(method === 'GET' ? (matches ? [row] : []) : (matches ? row : null)), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } },
  });
  return { store: new SupabaseAssistantStore(client), row, requests, fail: () => { fail = true; } };
}

test('persisted reminder reads and writes require the owner and an active row', async () => {
  const { store, row, requests } = fixture();
  assert.equal((await store.getReminder(6, 4242))?.id, 6);
  assert.equal(await store.getReminder(6, 9999), null);
  assert.equal(await store.updateReminder(6, 9999, { text: 'Intruder edit' }), null);
  assert.equal(row.text, 'Daily report');
  row.active = false;
  assert.equal(await store.updateReminder(6, 4242, { text: 'Revive edit' }), null);
  assert.equal(row.text, 'Daily report');
  for (const request of requests) {
    assert.equal(request.url.pathname, '/rest/v1/reminders');
    assert.equal(request.url.searchParams.get('id'), 'eq.6');
    assert.equal(request.url.searchParams.get('active'), 'eq.true');
    assert.ok(request.url.searchParams.has('user_id'));
  }
});

test('a persisted text edit does not overwrite next run or delivery metadata', async () => {
  const { store, row, requests } = fixture();
  const result = await store.updateReminder(6, 4242, { text: 'Edited report' });
  assert.equal(result?.text, 'Edited report');
  assert.equal(result?.id, 6);
  assert.deepEqual(requests.at(-1)?.body, { text: 'Edited report' });
  assert.equal(row.next_run_at, '2099-10-05T14:00:00Z');
  assert.equal(row.last_sent_at, '2099-10-04T14:00:00Z');
});

test('a persisted schedule edit replaces all rule fields in one update', async () => {
  const { store, row, requests } = fixture();
  await store.updateReminder(6, 4242, { text: 'One-off report', schedule: { nextRunAt: '2099-10-06T01:00:00Z', frequency: 'once' } });
  assert.deepEqual(requests.at(-1)?.body, {
    text: 'One-off report', next_run_at: '2099-10-06T01:00:00Z', frequency: 'once',
    time_of_day: null, day_of_week: null, day_of_month: null,
  });
  assert.equal(row.last_sent_at, '2099-10-04T14:00:00Z');
  assert.equal(row.active, true);
});

test('persisted edit failures are surfaced instead of claiming a successful save', async () => {
  const { store, fail } = fixture();
  fail();
  await assert.rejects(store.updateReminder(6, 4242, { text: 'Edited report' }), /Failed to update reminder/);
  await assert.rejects(store.getReminder(6, 4242), /Failed to read reminder/);
});
