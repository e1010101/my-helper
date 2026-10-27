import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Telegraf } from 'telegraf';
import { occurrenceKeyboard, occurrenceMessage, registerActionableReminderCommands } from '../src/commands/actionable-reminders.js';
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import { telegramVisibleLength } from '../src/utils/telegram-chunk.js';
import type { ReminderOccurrence } from '../src/services/reminder-action-store.js';

const require = createRequire(import.meta.url);
const { default: ApiClient } = require(join(dirname(require.resolve('telegraf')), 'core', 'network', 'client.js'));
const NOW = new Date('2026-10-27T06:00:00.000Z');
const TIMEZONE = 'Asia/Singapore';

function harness(t: TestContext, store = new InMemoryAssistantStore()) {
  const userId = 4242;
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const failMethods = new Set<string>();
  let updateId = 0;
  let messageId = 0;
  t.mock.method(ApiClient.prototype, 'callApi', async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (failMethods.has(method)) throw new Error('Telegram unavailable');
    return { message_id: method === 'sendMessage' ? ++messageId : payload.message_id, chat: { id: userId, type: 'private' }, date: 1, text: payload.text };
  });
  const bot = new Telegraf('123456:FAKE');
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  registerActionableReminderCommands(bot, { getStore: () => store, timezone: TIMEZONE, now: () => NOW });
  const from = (id: number) => ({ id, is_bot: false as const, first_name: 'Owner' });
  const chat = { id: userId, type: 'private' as const, first_name: 'Owner' };
  async function text(value: string, owner = userId) {
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, from: from(owner), chat, text: value,
      entities: [{ type: 'bot_command', offset: 0, length: value.split(/\s/)[0].length }],
    } });
  }
  async function tap(data: string, owner = userId, cardId = 100) {
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: `cb-${updateId}`, from: from(owner), chat_instance: 'test', data,
      message: { message_id: cardId, date: 1, chat, text: 'Full delivered reminder text' },
    } });
  }
  async function occurrence(content = 'Daily <report> & review', recurring = false) {
    const reminder = await store.createReminder({ userId, text: content, frequency: recurring ? 'daily' : 'once', timeOfDay: recurring ? '13:00' : undefined, nextRunAt: '2026-10-27T05:00:00.000Z' });
    const result = await store.materializeReminder(reminder, recurring ? '2026-10-28T05:00:00.000Z' : null, NOW);
    assert.ok(result);
    return result;
  }
  function output() { return calls.map(c => String(c.payload.text ?? '')).join('\n'); }
  const card = (action: string, row: ReminderOccurrence) => `occ:${action}:${row.id}:${row.version}`;
  return { store, bot, userId, calls, failMethods, text, tap, occurrence, output, card };
}

test('Done consumes only the selected occurrence and rejects replay without rewriting delivered text', async (t) => {
  const h = harness(t);
  const row = await h.occurrence('First daily reminder', true);
  const series = await h.store.getReminder(row.reminderId, h.userId);
  assert.ok(series);
  const next = await h.store.materializeReminder(series, '2026-10-29T05:00:00.000Z', new Date('2026-10-28T05:00:00.000Z'));
  assert.ok(next);
  await h.tap(h.card('done', row), h.userId, 123);
  await h.tap(h.card('done', row), h.userId, 123);
  const stored = await h.store.getReminderOccurrence(row.id, h.userId);
  assert.equal(stored?.status, 'done');
  assert.equal(stored?.version, row.version + 1);
  assert.equal((await h.store.getReminderOccurrence(next.id, h.userId))?.status, 'pending');
  assert.equal((await h.store.getReminder(row.reminderId, h.userId))?.nextRunAt, '2026-10-29T05:00:00.000Z');
  assert.equal(h.calls.filter(c => c.method === 'editMessageText').length, 0);
  const edits = h.calls.filter(c => c.method === 'editMessageReplyMarkup');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].payload.message_id, 123);
  assert.deepEqual(edits[0].payload.reply_markup, { inline_keyboard: [] });
  assert.equal(h.calls.filter(c => c.method === 'answerCallbackQuery').length, 2);
  assert.match(h.output(), /no longer available or has changed/);
});

test('Skip closes this occurrence while the recurring series stays active', async (t) => {
  const h = harness(t);
  const row = await h.occurrence('Recurring reminder', true);
  await h.tap(h.card('skip', row));
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.status, 'skipped');
  assert.equal((await h.store.getReminder(row.reminderId, h.userId))?.active, true);
  assert.equal((await h.store.listPendingReminderOccurrences(h.userId)).length, 0);
});

test('Snooze refreshes versioned controls; repeated snooze and stale Done cannot change it', async (t) => {
  const h = harness(t);
  const row = await h.occurrence('Snoozable reminder', true);
  await h.tap(h.card('10m', row));
  await h.tap(h.card('10m', row));
  await h.tap(h.card('done', row));
  const updated = await h.store.getReminderOccurrence(row.id, h.userId);
  assert.equal(updated?.status, 'pending');
  assert.equal(updated?.nextNotificationAt, '2026-10-27T06:10:00.000Z');
  assert.equal(updated?.version, row.version + 1);
  assert.equal((await h.store.getReminder(row.reminderId, h.userId))?.nextRunAt, '2026-10-28T05:00:00.000Z');
  const edits = h.calls.filter(c => c.method === 'editMessageReplyMarkup');
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].payload.reply_markup), new RegExp(`occ:done:${row.id}:${row.version + 1}`));
  assert.equal(h.calls.filter(c => c.method === 'editMessageText').length, 0);
  assert.equal(h.calls.filter(c => c.method === 'answerCallbackQuery').length, 3);
});

test('one-hour and tomorrow buttons use the configured local timezone', async (t) => {
  const h = harness(t);
  const hour = await h.occurrence();
  const tomorrow = await h.occurrence();
  await h.tap(h.card('1h', hour));
  await h.tap(h.card('tomorrow', tomorrow));
  assert.equal((await h.store.getReminderOccurrence(hour.id, h.userId))?.nextNotificationAt, '2026-10-27T07:00:00.000Z');
  assert.equal((await h.store.getReminderOccurrence(tomorrow.id, h.userId))?.nextNotificationAt, '2026-10-28T01:00:00.000Z');
});

test('another user cannot act on an occurrence or edit its message', async (t) => {
  const h = harness(t);
  const row = await h.occurrence();
  for (const action of ['done', 'skip', '10m', '1h', 'tomorrow']) await h.tap(h.card(action, row), h.userId + 1);
  assert.deepEqual(await h.store.getReminderOccurrence(row.id, h.userId), row);
  assert.equal(h.calls.filter(c => c.method.startsWith('edit')).length, 0);
  assert.equal(h.calls.filter(c => c.method === 'answerCallbackQuery').length, 5);
});

test('concurrent callbacks accept one action even if both read the old version', async (t) => {
  const h = harness(t);
  const row = await h.occurrence();
  await Promise.all([h.tap(h.card('done', row)), h.tap(h.card('10m', row))]);
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.version, row.version + 1);
  assert.equal(h.calls.filter(c => c.method === 'editMessageReplyMarkup').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'answerCallbackQuery').length, 2);
});

test('invalid callback IDs and unsupported actions are acknowledged without writes', async (t) => {
  const h = harness(t);
  const row = await h.occurrence();
  for (const data of ['occ:done:0:0', 'occ:done:99999999999999999999:0', 'occ:done:1:99999999999999999999', 'occ:other:1:0']) await h.tap(data);
  assert.deepEqual(await h.store.getReminderOccurrence(row.id, h.userId), row);
  assert.equal(h.calls.filter(c => c.method === 'answerCallbackQuery').length, 4);
});

test('failed Telegram acknowledgement or markup refresh cannot undo or repeat a saved action', async (t) => {
  const h = harness(t);
  t.mock.method(console, 'error', () => {});
  const row = await h.occurrence();
  h.failMethods.add('answerCallbackQuery');
  await h.tap(h.card('done', row));
  assert.equal(h.calls.filter(c => c.method === 'editMessageReplyMarkup').length, 1, 'a failed acknowledgement must not prevent markup refresh');
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.status, 'done');
  h.failMethods.clear();
  await h.tap(h.card('done', row));
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.version, row.version + 1);
  const another = await h.occurrence();
  h.failMethods.add('editMessageReplyMarkup');
  await h.tap(h.card('10m', another));
  h.failMethods.clear();
  await h.tap(h.card('10m', another));
  assert.equal((await h.store.getReminderOccurrence(another.id, h.userId))?.version, another.version + 1);
  assert.doesNotMatch(h.output(), /Could not save that action/);
});

test('/pending lists inactive one-off occurrences and is scoped to the sender', async (t) => {
  const h = harness(t);
  const row = await h.occurrence();
  assert.deepEqual(await h.store.listReminders(h.userId), []);
  await h.text('/pending');
  assert.match(h.output(), /Pending reminders \(1\)/);
  assert.match(h.output(), /Daily &lt;report&gt; &amp; review/);
  assert.match(h.output(), /Scheduled:.*27 Oct 2026, 13:00/);
  assert.match(h.output(), /Asia\/Singapore/);
  assert.match(JSON.stringify(h.calls), new RegExp(`occ:done:${row.id}:${row.version}`));
  h.calls.length = 0;
  await h.text('/pending', h.userId + 1);
  assert.match(h.output(), /No pending reminders/);
  assert.doesNotMatch(h.output(), /Daily/);
});

test('/pending preserves long escaped text and attaches actions to only its final chunk', async (t) => {
  const h = harness(t);
  const content = `${'<payload> & "quoted" 😀 '.repeat(700)}END_OF_REMINDER`;
  const row = await h.occurrence(content);
  await h.text('/pending');
  const messages = h.calls.filter(c => c.method === 'sendMessage' && c.payload.parse_mode === 'HTML');
  assert.ok(messages.length > 2);
  assert.equal(messages.filter(c => c.payload.reply_markup).length, 1);
  assert.ok(messages.at(-1)?.payload.reply_markup);
  for (const { payload } of messages) assert.ok(telegramVisibleLength(String(payload.text)) <= 4096);
  const combined = messages.map(c => String(c.payload.text)).join('');
  assert.equal((combined.match(/&lt;payload&gt;/g) ?? []).length, 700);
  assert.match(combined, /END_OF_REMINDER/);
  assert.doesNotMatch(combined, /<payload>/);
  assert.match(occurrenceMessage(row, TIMEZONE), /&lt;payload&gt; &amp; &quot;quoted&quot;/);
});

test('all occurrence callback payloads fit Telegram limits at maximum supported IDs', async (t) => {
  const h = harness(t);
  const row = { ...await h.occurrence(), id: Number.MAX_SAFE_INTEGER, version: Number.MAX_SAFE_INTEGER };
  const markup = occurrenceKeyboard(row);
  const buttons = markup.inline_keyboard.flat();
  assert.equal(buttons.length, 5);
  for (const button of buttons) {
    assert.ok('callback_data' in button);
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
  }
});

test('/reminders starts with quiet hours and follow-ups off and explains explicit opt-in', async (t) => {
  const h = harness(t);
  await h.text('/reminders');
  assert.match(h.output(), /Quiet hours:<\/b> Off/);
  assert.match(h.output(), /Follow-ups:<\/b> Off/);
  assert.match(h.output(), /up to 2 per occurrence/);
  assert.match(h.output(), /60 minutes apart/);
  assert.match(h.output(), /5 attempts per local day/);
  assert.match(h.output(), /Enabling applies to future deliveries/);
  const buttons = JSON.stringify(h.calls.find(c => c.method === 'sendMessage')?.payload.reply_markup);
  assert.match(buttons, /Follow-ups ON/);
  assert.match(buttons, /Follow-ups OFF/);
});

test('quiet-hour commands persist overnight hours, reject malformed/equal times, and support off', async (t) => {
  const h = harness(t);
  await h.text('/reminders quiet 22:00 08:00');
  const expected = { userId: h.userId, quietHoursStart: '22:00', quietHoursEnd: '08:00', followUpsEnabled: false };
  assert.deepEqual(await h.store.getReminderPreferences(h.userId), expected);
  for (const times of ['22:00 22:00', '24:00 08:00', '22:00 08:60', '9:00 08:00', 'foo bar']) {
    await h.text(`/reminders quiet ${times}`);
    assert.deepEqual(await h.store.getReminderPreferences(h.userId), expected);
  }
  assert.match(h.output(), /two different times in 24-hour HH:MM/);
  await h.text('/reminders quiet off');
  const updated = await h.store.getReminderPreferences(h.userId);
  assert.equal(updated.quietHoursStart, null);
  assert.equal(updated.quietHoursEnd, null);
});

test('explicit settings buttons are idempotent, survive re-registration, and reject another sender', async (t) => {
  const h = harness(t);
  await h.tap(`reminderprefs:on:${h.userId}`);
  await h.tap(`reminderprefs:on:${h.userId}`);
  assert.equal((await h.store.getReminderPreferences(h.userId)).followUpsEnabled, true);
  await h.tap(`reminderprefs:off:${h.userId}`, h.userId + 1);
  assert.equal((await h.store.getReminderPreferences(h.userId)).followUpsEnabled, true);
  assert.equal((await h.store.getReminderPreferences(h.userId + 1)).followUpsEnabled, false);
  const restarted = harness(t, h.store);
  await restarted.text('/reminders');
  assert.match(restarted.output(), /Follow-ups:<\/b> On/);
  await restarted.tap(`reminderprefs:off:${h.userId}`);
  await restarted.tap(`reminderprefs:off:${h.userId}`);
  assert.equal((await h.store.getReminderPreferences(h.userId)).followUpsEnabled, false);
});

test('turning follow-ups off via commands clears an already queued follow-up', async (t) => {
  const h = harness(t);
  await h.text('/reminders followups on');
  const row = await h.occurrence();
  await h.store.claimReminderOccurrence(row.id, row.version, NOW, new Date(NOW.getTime() + 60_000), 'delivery');
  await h.store.finishReminderOccurrence(row.id, row.version, 'delivery', NOW, '2026-10-27T07:00:00.000Z');
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.nextNotificationAt, '2026-10-27T07:00:00.000Z');
  await h.text('/reminders followups off');
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.nextNotificationAt, null);
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.status, 'pending');
  await h.text('/reminders followups on');
  assert.equal((await h.store.getReminderOccurrence(row.id, h.userId))?.nextNotificationAt, null, 'enabling must not revive old queued follow-ups');
});
