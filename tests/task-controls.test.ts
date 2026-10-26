import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Telegraf } from 'telegraf';
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import { getLocalParts } from '../src/services/reminder-time.js';
import type { Task } from '../src/services/database.js';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'fake';
const { registerCommands } = await import('../src/commands/index.js');
const { db } = await import('../src/services/database.js');
const require = createRequire(import.meta.url);
const { default: ApiClient } = require(join(dirname(require.resolve('telegraf')), 'core', 'network', 'client.js'));

let nextUserId = 7000;
function harness(t: TestContext) {
  const userId = nextUserId++;
  const store = new InMemoryAssistantStore();
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const updates: unknown[][] = [];
  const deletions: unknown[][] = [];
  const fallback: string[] = [];
  let todo: Task | null = { id: 1, user_id: userId, name: 'Original todo', description: 'Original description', completed: false, created_at: '2026-10-04T14:00:00Z' };
  let messageId = 0;
  let updateId = 0;
  t.mock.method(ApiClient.prototype, 'callApi', async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    return { message_id: method === 'sendMessage' ? ++messageId : payload.message_id, chat: { id: payload.chat_id, type: 'private' }, date: 1, text: payload.text };
  });
  t.mock.method(db, 'logCommand', async () => {});
  t.mock.method(db, 'getTasksByUser', async (owner: number) => todo && todo.user_id === owner ? [{ ...todo }] : []);
  t.mock.method(db, 'getTask', async (id: number, owner: number) => todo && todo.id === id && todo.user_id === owner ? { ...todo } : null);
  t.mock.method(db, 'updateTask', async (id: number, owner: number, name: string, description: string) => {
    assert.equal(id, todo?.id);
    assert.equal(owner, userId);
    updates.push([id, owner, name, description]);
    todo = { ...todo!, name, description };
  });
  t.mock.method(db, 'deleteTask', async (id: number, owner: number) => {
    assert.equal(id, todo?.id);
    assert.equal(owner, userId);
    deletions.push([id, owner]);
    todo = null;
  });
  t.mock.method(db, 'updateTaskStatus', async (id: number, owner: number, completed: boolean) => {
    assert.equal(id, todo?.id);
    assert.equal(owner, userId);
    todo = { ...todo!, completed };
  });
  const bot = new Telegraf('123456:FAKE');
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  registerCommands(bot, { getStore: () => store, timezone: 'Asia/Singapore' });
  bot.on('text', (ctx) => { fallback.push(ctx.message.text); });
  const from = (id: number) => ({ id, is_bot: false as const, first_name: 'Owner' });
  const chat = { id: userId, type: 'private' as const, first_name: 'Owner' };
  async function text(value: string) {
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, from: from(userId), chat, text: value,
      entities: value.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: value.split(/\s/)[0].length }] : [],
    } });
  }
  async function tap(data: string, id = 100, owner = userId) {
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: `cb-${updateId}`, from: from(owner), chat_instance: 'test', data,
      message: { message_id: id, date: 1, chat, text: 'Item card' },
    } });
  }
  function lastSendId() { return messageId; }
  function output() { return calls.filter(c => ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(c.method)).map(c => String(c.payload.text ?? '')).join('\n'); }
  async function reminder() {
    return store.createReminder({ userId, text: 'Daily <report> & review', frequency: 'daily', timeOfDay: '22:00', nextRunAt: '2099-10-05T14:00:00Z' });
  }
  return { store, userId, calls, updates, deletions, fallback, text, tap, lastSendId, output, reminder, todo: () => todo };
}

test('/tasks gives each item an ID, metadata and correctly namespaced controls', async (t) => {
  const h = harness(t);
  const reminder = await h.reminder();
  await h.text('/tasks');
  const cards = h.calls.filter(c => c.method === 'sendMessage' && c.payload.reply_markup);
  assert.equal(cards.length, 2);
  assert.match(String(cards[0].payload.text), /To-do \[ID: 1\]/);
  assert.match(String(cards[0].payload.text), /Created:.*|<b>Created:<\/b>/);
  assert.match(JSON.stringify(cards[0].payload.reply_markup), /task:edit:1/);
  assert.match(JSON.stringify(cards[0].payload.reply_markup), /task:delete:1/);
  assert.match(JSON.stringify(cards[0].payload.reply_markup), /task:complete:1/);
  assert.match(String(cards[1].payload.text), new RegExp(`Reminder \\[ID: ${reminder.id}\\]`));
  assert.match(String(cards[1].payload.text), /Daily &lt;report&gt; &amp; review/);
  assert.match(String(cards[1].payload.text), /Schedule:|<b>Schedule:<\/b>/);
  assert.match(String(cards[1].payload.text), /Next run:|<b>Next run:<\/b>/);
  assert.match(String(cards[1].payload.text), /Last sent:|<b>Last sent:<\/b>/);
  assert.match(JSON.stringify(cards[1].payload.reply_markup), /reminder:edit:1/);
  assert.match(JSON.stringify(cards[1].payload.reply_markup), /reminder:delete:1/);
});

test('todo edit is prefilled, waits for Submit and consumes form text', async (t) => {
  const h = harness(t);
  await h.tap('task:edit:1');
  const formId = h.lastSendId();
  assert.match(h.output(), /Edit To-do \[ID: 1\]/);
  assert.match(h.output(), /Original description/);
  await h.tap('task:set_name', formId);
  await h.text('Updated <todo>');
  assert.equal(h.updates.length, 0);
  assert.deepEqual(h.fallback, []);
  await h.tap('task:submit', formId);
  assert.deepEqual(h.updates, [[1, h.userId, 'Updated <todo>', 'Original description']]);
  await h.tap('task:submit', formId);
  assert.equal(h.updates.length, 1, 'stale submit cannot write again');
  assert.match(h.output(), /no longer active/);
});

test('todo delete requires confirmation, supports Keep, and rejects a replay', async (t) => {
  const h = harness(t);
  await h.tap('task:delete:1');
  assert.equal(h.deletions.length, 0);
  assert.match(JSON.stringify(h.calls.at(-1)?.payload.reply_markup), /Confirm delete/);
  await h.tap('task:cancel_delete:1');
  assert.equal(h.deletions.length, 0);
  await h.tap('task:delete:1');
  await h.tap('task:confirm_delete:1');
  assert.deepEqual(h.deletions, [[1, h.userId]]);
  await h.tap('task:confirm_delete:1');
  assert.equal(h.deletions.length, 1);
  assert.match(h.output(), /Task not found/);
});

test('another user cannot edit, delete or toggle a todo', async (t) => {
  const h = harness(t);
  for (const action of ['edit', 'delete', 'confirm_delete', 'complete', 'reopen', 'toggle']) await h.tap(`task:${action}:1`, 100, h.userId + 99);
  assert.equal(h.updates.length, 0);
  assert.equal(h.deletions.length, 0);
  assert.equal(h.todo()?.completed, false);
  assert.match(h.output(), /Task not found/);
});

test('todo completion refreshes its own card with edit/delete buttons intact', async (t) => {
  const h = harness(t);
  await h.tap('task:complete:1');
  assert.equal(h.todo()?.completed, true);
  const edit = h.calls.find(c => c.method === 'editMessageText');
  assert.match(String(edit?.payload.text), /Completed/);
  assert.match(JSON.stringify(edit?.payload.reply_markup), /task:edit:1/);
  assert.match(JSON.stringify(edit?.payload.reply_markup), /task:reopen:1/);
});

test('stale completion cards and repeated callbacks preserve the requested state', async (t) => {
  const h = harness(t);
  await h.text('/tasks');
  const firstCard = h.lastSendId();
  await h.text('/tasks');
  const secondCard = h.lastSendId();
  await h.tap('task:complete:1', firstCard);
  await h.tap('task:complete:1', secondCard);
  await h.tap('task:complete:1', secondCard);
  assert.equal(h.todo()?.completed, true);
  await h.tap('task:reopen:1', firstCard);
  await h.tap('task:reopen:1', secondCard);
  assert.equal(h.todo()?.completed, false);
});

test('legacy toggle cards refresh without changing task state', async (t) => {
  const h = harness(t);
  await h.tap('task:toggle:1');
  assert.equal(h.todo()?.completed, false);
  assert.match(h.output(), /Card refreshed/);
  assert.match(JSON.stringify(h.calls.find(c => c.method === 'editMessageText')?.payload.reply_markup), /task:complete:1/);
});

test('a successful task save stays consumed when all confirmation messages fail', async (t) => {
  const h = harness(t);
  let inserts = 0;
  t.mock.method(db, 'createTask', async () => { inserts++; });
  await h.text('/task -create');
  const formId = h.lastSendId();
  await h.tap('task:set_name', formId);
  await h.text('Save exactly once');
  await h.tap('task:set_description', formId);
  await h.text('Telegram might be unavailable afterwards');
  const transport = ApiClient.prototype.callApi;
  let fail = true;
  t.mock.method(ApiClient.prototype, 'callApi', async (method: string, payload: Record<string, unknown>) => {
    if (fail && ['sendMessage', 'editMessageText'].includes(method)) throw new Error('Telegram unavailable');
    return transport.call(ApiClient.prototype, method, payload);
  });
  await h.tap('task:submit', formId);
  assert.equal(inserts, 1);
  fail = false;
  await h.tap('task:submit', formId);
  assert.equal(inserts, 1);
  assert.match(h.output(), /no longer active/);
  assert.doesNotMatch(h.output(), /Failed to save task/);
});

test('/task -read returns all long field content in bounded HTML messages', async (t) => {
  const h = harness(t);
  const name = '<&😀>'.repeat(600);
  const description = 'long description '.repeat(350);
  t.mock.method(db, 'getTask', async () => ({ ...h.todo()!, name, description }));
  await h.text('/task -read 1');
  const texts = h.calls.filter(c => c.method === 'sendMessage').map(c => String(c.payload.text));
  assert.ok(texts.length > 1);
  const visible = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const text of texts) {
    assert.ok(visible(text).length <= 4096);
    assert.doesNotMatch(text, /&(?!amp;|lt;|gt;|quot;|#39;)/);
  }
  const combined = texts.map(visible).join('');
  assert.ok(combined.includes(name));
  assert.equal((combined.match(/long/g) ?? []).length, 350);
  assert.equal((combined.match(/description/g) ?? []).length, 350);
});

test('reminder text edit preserves ID and an occurrence advanced while editing', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:text:${r.id}`);
  await h.text('New reminder text');
  assert.equal(r.text, 'Daily <report> & review');
  assert.deepEqual(h.fallback, []);
  await h.store.markReminderSent(r.id, '2099-10-06T14:00:00Z', '2099-10-05T14:00:00Z', r);
  await h.tap(`reminder:save:${r.id}`);
  const updated = await h.store.getReminder(r.id, h.userId);
  assert.equal(updated?.text, 'New reminder text');
  assert.equal(updated?.nextRunAt, '2099-10-06T14:00:00Z');
  assert.equal(updated?.frequency, 'daily');
  assert.equal(updated?.lastSentAt, '2099-10-05T14:00:00Z');
  assert.match(h.output(), /Saved/);
});

test('reminder schedule edit validates input and stores a new weekly wall-clock rule', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:schedule:${r.id}`);
  for (const bad of ['whenever', '2000-01-01T00:00:00Z', 'every weekday at 09:00']) {
    await h.text(bad);
    assert.equal(r.frequency, 'daily');
  }
  await h.text('every Monday at 09:00');
  assert.equal(r.frequency, 'daily', 'still unchanged before Save');
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.frequency, 'weekly');
  assert.equal(r.dayOfWeek, 1);
  assert.equal(r.timeOfDay, '09:00');
  assert.equal(getLocalParts(new Date(r.nextRunAt), 'Asia/Singapore').hour, 9);
  assert.deepEqual(h.fallback, []);
});

test('reminder editor interprets an ISO datetime without an offset in its configured timezone', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:schedule:${r.id}`);
  await h.text('2099-10-05T09:00');
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.nextRunAt, '2099-10-05T01:00:00.000Z');
  assert.equal(r.frequency, 'once');
  assert.equal(getLocalParts(new Date(r.nextRunAt), 'Asia/Singapore').hour, 9);
});

test('monthly schedule edits and reverting to a one-off clear obsolete rule fields', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:schedule:${r.id}`);
  await h.text('every month on day 15 at 09:00');
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.frequency, 'monthly');
  assert.equal(r.dayOfMonth, 15);
  assert.equal(getLocalParts(new Date(r.nextRunAt), 'Asia/Singapore').day, 15);
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:schedule:${r.id}`);
  await h.text('in 2 hours');
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.frequency, 'once');
  assert.equal(r.dayOfMonth, null);
  assert.equal(r.dayOfWeek, null);
  assert.equal(r.timeOfDay, null);
});

test('a reminder save failure preserves the draft for retry without duplicating the reminder', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  const update = h.store.updateReminder.bind(h.store);
  let attempts = 0;
  t.mock.method(h.store, 'updateReminder', async (...args: Parameters<typeof update>) => {
    if (++attempts === 1) throw new Error('Temporary database failure');
    return update(...args);
  });
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:text:${r.id}`);
  await h.text('Retry text');
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.text, 'Daily <report> & review');
  assert.match(h.output(), /draft is kept/);
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.text, 'Retry text');
  assert.equal((await h.store.listReminders(h.userId)).length, 1);
});

test('reminder cancellation discards edits and stale forms cannot save', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:text:${r.id}`);
  await h.text('Discarded');
  await h.tap(`reminder:cancel:${r.id}`);
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.text, 'Daily <report> & review');
  assert.match(h.output(), /expired/);
});

test('another user cannot edit or delete a reminder; inactive reminders cannot be saved', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  for (const action of ['edit', 'delete', 'confirm_delete']) await h.tap(`reminder:${action}:${r.id}`, 100, h.userId + 99);
  assert.equal(r.active, true);
  assert.match(h.output(), /not found/);
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:text:${r.id}`);
  await h.text('Stale edit');
  await h.store.cancelReminder(r.id, h.userId);
  await h.tap(`reminder:save:${r.id}`);
  assert.equal(r.text, 'Daily <report> & review');
  assert.equal(r.active, false);
  assert.match(h.output(), /no longer active/);
});

test('reminder delete waits for confirmation and stops future runs', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.tap(`reminder:delete:${r.id}`);
  assert.equal(r.active, true);
  await h.tap(`reminder:cancel_delete:${r.id}`);
  assert.equal(r.active, true);
  await h.tap(`reminder:delete:${r.id}`);
  await h.tap(`reminder:confirm_delete:${r.id}`);
  assert.equal(r.active, false);
  assert.equal((await h.store.listDueReminders(new Date('2100-01-01'))).length, 0);
  await h.tap(`reminder:confirm_delete:${r.id}`);
  assert.match(h.output(), /no longer active/);
});

test('double-tapping reminder Save performs one write', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const update = h.store.updateReminder.bind(h.store);
  let writes = 0;
  t.mock.method(h.store, 'updateReminder', async (...args: Parameters<typeof update>) => {
    writes++;
    entered();
    await gate;
    return update(...args);
  });
  await h.tap(`reminder:edit:${r.id}`);
  const firstSave = h.tap(`reminder:save:${r.id}`);
  await started;
  try {
    await h.tap(`reminder:save:${r.id}`);
    assert.equal(writes, 1);
  } finally {
    release();
    await firstSave;
  }
});

test('starting a reminder editor replaces a prompt draft and routes later text normally after Cancel', async (t) => {
  const h = harness(t);
  const r = await h.reminder();
  await h.text('/prompt');
  await h.tap(`reminder:edit:${r.id}`);
  await h.tap(`reminder:cancel:${r.id}`);
  await h.text('Normal conversation');
  assert.deepEqual(h.fallback, ['Normal conversation']);
});
