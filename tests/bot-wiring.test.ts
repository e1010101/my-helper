/**
 * Wiring test: builds the real Bot and drives real Telegram updates through it.
 *
 * This exists because every unit test injects its own store and client, so
 * nothing else would catch the bot failing to connect the pieces together.
 *
 * Telegraf constructs a fresh Telegram instance per update, so the only way to
 * intercept the network is to stub the ApiClient prototype they all inherit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// Statically imported for its type; the class itself is constructed below.
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import type { ReminderOccurrence } from '../src/services/reminder-action-store.js';
import type { ReminderScheduler } from '../src/services/reminder-scheduler.js';

process.env.NODE_ENV = 'production'; // keep the logger quiet
// The sandbox blocks binding 3000, and start() opens a real health server.
process.env.PORT = '3399';
process.env.TELEGRAM_BOT_TOKEN = '123456:FAKE_TOKEN_FOR_TESTS';
// Unroutable on purpose: makes the Supabase-backed store fail deterministically.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
// A real provider key is never used (the model is scripted below), but the
// config layer validates that exactly one provider is configured. Pin the
// choice so a developer's .env cannot change what this test exercises.
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'fake-deepseek-key';
delete process.env.GEMINI_API_KEY;
process.env.ADMIN_USER_ID = '4242';
process.env.TIMEZONE = 'Asia/Singapore';
delete process.env.WEBHOOK_DOMAIN;

const require = createRequire(import.meta.url);
// telegraf's "exports" map does not expose internals, so resolve to a real path.
const ApiClientPath = join(dirname(require.resolve('telegraf')), 'core', 'network', 'client.js');
const ApiClient = require(ApiClientPath) as {
  default: { prototype: { callApi(method: string, payload: unknown, signal?: unknown): Promise<unknown> } };
};

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const apiCalls: ApiCall[] = [];
let messageIds = 0;
let lastMarkup: unknown;

ApiClient.default.prototype.callApi = async function (method: string, payload: unknown) {
  const record = (payload ?? {}) as Record<string, unknown>;
  apiCalls.push({ method, payload: record });

  if (method === 'getMe') {
    return { id: 1, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  }
  if (method === 'sendMessage' || method === 'sendPhoto') {
    messageIds += 1;
    lastMarkup = record.reply_markup;
    return {
      message_id: messageIds,
      date: Math.floor(Date.now() / 1000),
      chat: { id: record.chat_id, type: 'private' },
      text: String(record.text ?? ''),
    };
  }
  return { message_id: messageIds += 1 };
};

const { Bot } = await import('../src/bot.js');
const { db } = await import('../src/services/database.js');

interface AssistantInternals {
  store: unknown;
  client: unknown;
}

const bot = new Bot();
const assistant = bot.getAssistant();
const telegraf = bot.getBot();

let updateId = 0;
let callbackId = 0;

async function sendText(text: string): Promise<void> {
  updateId += 1;

  // Real Telegram updates mark commands with a bot_command entity, and
  // Telegraf's command matcher reads the command from that entity rather than
  // from the text. Omitting it silently routes every command to the fallback.
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }]
    : [];

  await telegraf.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 4242, type: 'private' },
      from: { id: 4242, is_bot: false, first_name: 'Owner', username: 'owner' },
      text,
      entities,
    },
  } as never);
}

async function tapButton(data: string): Promise<void> {
  callbackId += 1;
  updateId += 1;
  await telegraf.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cb-${callbackId}`,
      from: { id: 4242, is_bot: false, first_name: 'Owner', username: 'owner' },
      chat_instance: 'instance',
      data,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 4242, type: 'private' },
        text: 'Confirm action',
      },
    },
  } as never);
}

function messages(): string[] {
  return apiCalls
    .filter((call) => call.method === 'sendMessage' || call.method === 'sendPhoto')
    .map((call) => String(call.payload.text ?? call.payload.caption ?? ''));
}

function lastMessage(): string {
  const all = messages();
  return all[all.length - 1] ?? '';
}

/** All replies joined, for handlers that send more than one message. */
function allMessages(): string {
  return messages().join('\n---\n');
}

/** Replaces the model with one that always asks for the given tool call. */
function scriptToolCall(name: string, args: Record<string, unknown>): void {
  (assistant as unknown as AssistantInternals).client = {
    name: 'scripted-tool',
    async generate() {
      return { text: '', toolCalls: [{ id: `call-${name}`, name, args }] };
    },
    async generateText() {
      return '';
    },
  };
}

function scriptText(text: string): void {
  (assistant as unknown as AssistantInternals).client = {
    name: 'scripted-text',
    async generate() {
      return { text, toolCalls: [] };
    },
    async generateText() {
      return '';
    },
  };
}

test('the real scheduler sends owner-scoped buttons that resolve a delivered one-off through middleware', async (t) => {
  const store = new InMemoryAssistantStore();
  const internals = assistant as unknown as AssistantInternals;
  const scheduler = (bot as unknown as { scheduler: ReminderScheduler }).scheduler;
  const schedulerInternals = scheduler as unknown as { store: unknown };
  const previousStore = internals.store;
  const previousSchedulerStore = schedulerInternals.store;
  internals.store = store;
  schedulerInternals.store = store;
  t.after(() => { internals.store = previousStore; schedulerInternals.store = previousSchedulerStore; });
  const nextRunAt = new Date(Date.now() - 60_000).toISOString();
  const reminder = await store.createReminder({ userId: 4242, text: 'Call <mum> & dad', frequency: 'once', nextRunAt });
  await store.createReminder({ userId: 9999, text: 'Another owner', frequency: 'once', nextRunAt });

  apiCalls.length = 0;
  const delivered = await scheduler.tick();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].reminderId, reminder.id);
  const sent = apiCalls.filter(call => call.method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.chat_id, 4242);
  assert.match(String(sent[0].payload.text), /Call &lt;mum&gt; &amp; dad/);
  const occurrence = (await store.listPendingReminderOccurrences(4242))[0];
  assert.match(JSON.stringify(sent[0].payload.reply_markup), new RegExp(`occ:done:${occurrence.id}:${occurrence.version}`));
  assert.equal(occurrence.nextNotificationAt, null, 'follow-ups default off');
  assert.equal((await store.listReminders(4242)).length, 0, 'one-off series is inactive after materialization');
  assert.equal((await store.listReminders(9999)).length, 1, 'another user schedule was not consumed');

  apiCalls.length = 0;
  await sendText('/pending');
  assert.match(allMessages(), /Call &lt;mum&gt; &amp; dad/);
  await tapButton(`occ:done:${occurrence.id}:${occurrence.version}`);
  assert.equal((await store.getReminderOccurrence(occurrence.id, 4242))?.status, 'done');
});

test('reminder preference commands and buttons reach persistence through the real middleware', async (t) => {
  const store = new InMemoryAssistantStore();
  const internals = assistant as unknown as AssistantInternals;
  const previousStore = internals.store;
  internals.store = store;
  t.after(() => { internals.store = previousStore; });

  apiCalls.length = 0;
  await sendText('/reminders');
  assert.match(lastMessage(), /Follow-ups:<\/b> Off/);
  await sendText('/reminders quiet 22:00 08:00');
  await sendText('/reminders followups on');
  assert.deepEqual(await store.getReminderPreferences(4242), {
    userId: 4242, quietHoursStart: '22:00', quietHoursEnd: '08:00', followUpsEnabled: true,
  });
  await tapButton('reminderprefs:off:4242');
  assert.equal((await store.getReminderPreferences(4242)).followUpsEnabled, false);
});

async function leasedOccurrence(text: string): Promise<ReminderOccurrence> {
  const store = new InMemoryAssistantStore();
  const now = new Date();
  const reminder = await store.createReminder({ userId: 4242, text, frequency: 'once', nextRunAt: now.toISOString() });
  const occurrence = await store.materializeReminder(reminder, null, now);
  assert.ok(occurrence);
  const leased = await store.claimReminderOccurrence(occurrence.id, occurrence.version, now, new Date(now.getTime() + 60_000), 'test-lease');
  assert.ok(leased);
  return leased;
}

test('reminder transport splits long text and attaches controls once, to the final chunk', async () => {
  const occurrence = await leasedOccurrence('<report> & details '.repeat(800));
  apiCalls.length = 0;
  await (bot as unknown as { deliverReminder(occurrence: ReminderOccurrence): Promise<void> }).deliverReminder(occurrence);
  const sent = apiCalls.filter(call => call.method === 'sendMessage');
  assert.ok(sent.length > 1);
  assert.ok(sent.slice(0, -1).every(call => call.payload.reply_markup === undefined));
  assert.match(JSON.stringify(sent.at(-1)?.payload.reply_markup), /occ:done:/);
  assert.ok(sent.every(call => String(call.payload.text).replace(/<[^>]+>|&(?:lt|gt|amp);/g, '').length <= 4096));
});

test('reminder transport rejects wrong owners and expired leases and aborts a stalled send within its lease', async (t) => {
  const occurrence = await leasedOccurrence('Bounded send');
  const transport = bot as unknown as { deliverReminder(occurrence: ReminderOccurrence): Promise<void> };
  apiCalls.length = 0;
  await assert.rejects(transport.deliverReminder({ ...occurrence, userId: 9999 }), /configured owner/);
  await assert.rejects(transport.deliverReminder({ ...occurrence, leaseUntil: new Date(0).toISOString() }), /lease expired/);
  assert.equal(apiCalls.length, 0);

  const fixedNow = Date.now();
  t.mock.method(Date, 'now', () => fixedNow);
  let signal: AbortSignal | undefined;
  t.mock.method(bot.getBot().telegram, 'callApi', (_method: string, _payload: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await assert.rejects(transport.deliverReminder({ ...occurrence, leaseUntil: new Date(fixedNow + 1_030).toISOString() }), /timed out/);
  assert.equal(signal?.aborted, true);
});

test('a command is answered through the real middleware chain', async () => {
  apiCalls.length = 0;
  await sendText('/ping');
  // /ping replies twice: the pong, then the latency.
  assert.match(allMessages(), /Pong/);
});

test('an unknown command is reported and never reaches the model', async () => {
  apiCalls.length = 0;
  await sendText('/definitelynotacommand');
  assert.match(lastMessage(), /Unknown command/);
});

test('a plain message answers even when storage is unavailable', async () => {
  apiCalls.length = 0;
  scriptText('Hello, even without memory.');
  await sendText('hello there');
  assert.match(lastMessage(), /Hello, even without memory/);
});

test('a write request produces Confirm/Cancel buttons and writes nothing', async () => {
  const store = new InMemoryAssistantStore();
  const internals = assistant as unknown as AssistantInternals;
  internals.store = store;
  scriptToolCall('create_reminder', { text: 'Call mum', when_text: 'in 30 minutes' });

  apiCalls.length = 0;
  await sendText('remind me to call mum in 30 minutes');

  assert.match(lastMessage(), /Confirm action/);
  assert.match(lastMessage(), /create_reminder/i);
  assert.match(JSON.stringify(lastMarkup), /assistant:confirm:1/);
  assert.match(JSON.stringify(lastMarkup), /assistant:reject:1/);

  assert.equal((await store.listReminders(4242)).length, 0, 'nothing written before confirmation');
});

test('tapping Confirm executes the write and reports back', async () => {
  const internals = assistant as unknown as AssistantInternals;
  const store = internals.store as InMemoryAssistantStore;
  scriptText('Scheduled for you.');

  apiCalls.length = 0;
  await tapButton('assistant:confirm:1');

  const reminders = await store.listReminders(4242);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].text, 'Call mum');
  assert.match(lastMessage(), /Scheduled/);
});

test('tapping Cancel leaves the store untouched', async () => {
  const internals = assistant as unknown as AssistantInternals;
  const store = internals.store as InMemoryAssistantStore;
  scriptToolCall('save_fact', { key: 'home_city', value: 'Singapore' });

  await sendText('remember I live in Singapore');
  assert.match(lastMessage(), /Confirm action/);

  apiCalls.length = 0;
  await tapButton('assistant:reject:2');

  assert.equal(await store.getFact(4242, 'home_city'), null);
  assert.match(lastMessage(), /cancelled/i);
});

test('a pending confirmation cannot be approved by another user', async () => {
  const internals = assistant as unknown as AssistantInternals;
  const store = internals.store as InMemoryAssistantStore;
  scriptToolCall('save_fact', { key: 'other', value: 'x' });

  await sendText('remember something');
  const pendingBefore = await store.getFact(4242, 'other');

  updateId += 1;
  await telegraf.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: 'cb-intruder',
      from: { id: 9999, is_bot: false, first_name: 'Someone', username: 'someone' },
      chat_instance: 'instance',
      data: 'assistant:confirm:3',
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 9999, type: 'private' },
        text: 'Confirm action',
      },
    },
  } as never);

  assert.equal(pendingBefore, null);
  assert.equal(await store.getFact(4242, 'other'), null);
  assert.equal(await store.getFact(9999, 'other'), null);
});

test('/memory reads back stored facts and reminders', async () => {
  const internals = assistant as unknown as AssistantInternals;
  const store = internals.store as InMemoryAssistantStore;
  await store.saveFact(4242, 'home_city', 'Singapore');
  await store.createReminder({
    userId: 4242,
    text: 'Water plants',
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    frequency: 'once',
  });

  apiCalls.length = 0;
  await sendText('/memory');

  assert.match(lastMessage(), /What I remember/);
  assert.match(lastMessage(), /home_city/);
  assert.match(lastMessage(), /Water plants/);
});

test('/status answers the admin with a health report', async () => {
  apiCalls.length = 0;
  await sendText('/status');

  // The dependencies are unreachable in tests, so the report should say so
  // rather than crashing — this also exercises the health path end to end.
  assert.match(allMessages(), /Bot Status/);
  assert.match(allMessages(), /Database:/);
});

test('/forget clears conversation memory only', async () => {
  const internals = assistant as unknown as AssistantInternals;
  const store = internals.store as InMemoryAssistantStore;
  scriptText('Noted.');
  await sendText('something to remember');

  apiCalls.length = 0;
  await sendText('/forget');

  assert.match(lastMessage(), /memory cleared/i);
  assert.equal(await store.countMessages(4242), 0);
  assert.equal((await store.getFact(4242, 'home_city'))?.value, 'Singapore');
});

test('a reply longer than the message limit arrives in several parts', async () => {
  // Without chunking this send is rejected by Telegram, and the failure lands
  // in the handler's catch — so the user sees "having trouble" instead of the
  // answer. The model is fine; the transport was the problem.
  const longAnswer = `**Report**\n\n${'word '.repeat(2000)}`;
  scriptText(longAnswer);

  apiCalls.length = 0;
  await sendText('give me a long answer');

  const parts = messages();
  assert.ok(parts.length > 1, `expected several messages, got ${parts.length}`);

  const limit = /<[^>]+>|&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
  for (const part of parts) {
    // Telegram counts visible characters: markup does not contribute.
    const visible = part.replace(limit, '').length;
    assert.ok(visible <= 4096, `part of ${visible} visible characters exceeds the limit`);
  }

  assert.ok(
    parts.join('').includes('word'),
    'the answer body survived the split'
  );
});

test('a normal-length reply is still sent as a single message', async () => {
  scriptText('A short answer.');

  apiCalls.length = 0;
  await sendText('short question');

  assert.equal(messages().length, 1, 'no unnecessary splitting');
  assert.match(lastMessage(), /A short answer/);
});

test('/health and /ready answer different questions', async () => {
  // Regression guard: a database outage must not fail the platform's liveness
  // check. Restarting cannot repair the database, and a crash loop would take
  // the bot down entirely rather than degrading.
  const target = new Bot();
  const healthService = (target as unknown as {
    healthService: {
      getHealthStatus(options?: { checkDatabase?: boolean }): Promise<Record<string, unknown>>;
    };
  }).healthService;

  const httpServer = (target as unknown as {
    createHttpServer(): import('http').Server;
  }).createHttpServer();

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const status = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { code: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  try {
    // Telegram reachable, database broken.
    const probes: boolean[] = [];
    healthService.getHealthStatus = async (options) => {
      probes.push(options?.checkDatabase !== false);
      return {
      status: 'unhealthy',
      bot: { connected: true, mode: 'webhook' },
      database: { connected: false, error: 'cannot write to the assistant tables' },
      };
    };

    const healthDown = await status('/health');
    assert.equal(healthDown.code, 200, 'liveness must pass while the bot can still serve');
    assert.equal(healthDown.body.check, 'health');

    const readyDown = await status('/ready');
    assert.equal(readyDown.code, 503, 'readiness must fail while the database is unusable');
    assert.equal(readyDown.body.check, 'ready');
    assert.deepEqual(probes, [false, true], 'only readiness may start database work');

    // Both healthy.
    healthService.getHealthStatus = async () => ({
      status: 'healthy',
      bot: { connected: true, mode: 'webhook' },
      database: { connected: true, latency: 5 },
    });
    assert.equal((await status('/health')).code, 200);
    assert.equal((await status('/ready')).code, 200);

    // Telegram unreachable: a restart genuinely might help, so both fail.
    healthService.getHealthStatus = async () => ({
      status: 'unhealthy',
      bot: { connected: false, mode: 'webhook' },
      database: { connected: true },
    });
    assert.equal((await status('/health')).code, 503);
    assert.equal((await status('/ready')).code, 503);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    target.dispose();
  }
});

test('a transient polling failure is retried rather than killing the service', async () => {
  // Regression guard: a network blip must not take the bot down. By the time
  // polling starts, the HTTP server and reminder scheduler are already running,
  // so retrying is strictly better than exiting. (A rejected token is the
  // opposite case and still exits, which cannot be asserted here without
  // stopping the test runner.)
  const previousPort = process.env.PORT;
  process.env.PORT = '3398';

  const pollingBot = new Bot();
  const attempts: string[] = [];
  let shouldFail = true;

  (pollingBot.getBot() as unknown as { launch(): Promise<void> }).launch = () => {
    if (shouldFail) {
      shouldFail = false;
      attempts.push('fail');
      return Promise.reject(new Error('request to api.telegram.org failed, reason: read ECONNRESET'));
    }
    attempts.push('ok');
    // Settle so the method returns instead of polling forever.
    return Promise.resolve();
  };

  try {
    await pollingBot.start();

    const internals = pollingBot as unknown as { scheduler: { isRunning(): boolean } };
    assert.equal(internals.scheduler.isRunning(), true, 'the scheduler still starts');

    // Wait past the first retry backoff (2s).
    await new Promise((resolve) => setTimeout(resolve, 2600));

    assert.deepEqual(attempts, ['fail', 'ok'], 'launch was retried after the transient error');
  } finally {
    pollingBot.dispose();
    await pollingBot.stop('test');
    process.env.PORT = previousPort;
  }
});

test('polling mode starts the reminder scheduler even though launch() never resolves', async () => {
  // Regression test: Telegraf's launch() returns the long-poll loop promise, so
  // it does not settle while polling. Awaiting it blocked everything after it,
  // which meant reminders were never delivered in polling mode.
  const pollingBot = new Bot();
  const internals = pollingBot as unknown as {
    httpServer: unknown;
    scheduler: { start(): void; stop(): void; isRunning(): boolean };
  };

  // A real health server is bound on PORT (3399, set above) and closed again by
  // stop(). Only Telegram is stubbed, via launch().
  (pollingBot.getBot() as unknown as { launch(): Promise<void> }).launch = () =>
    new Promise<void>(() => {});

  const started: string[] = [];
  const realStart = internals.scheduler.start.bind(internals.scheduler);
  internals.scheduler.start = () => {
    started.push('scheduler');
    realStart();
  };

  // If start() awaited launch(), this would hang and the test would time out.
  await pollingBot.start();

  assert.deepEqual(started, ['scheduler'], 'the scheduler must be started');
  assert.equal(internals.scheduler.isRunning(), true);

  pollingBot.dispose();
  await pollingBot.stop('test');
});

test('/tasks lists scheduled reminders alongside todos through the real bot', async (t) => {
  const internals = assistant as unknown as AssistantInternals;
  const previousStore = internals.store;
  t.after(() => { internals.store = previousStore; });

  const store = new InMemoryAssistantStore();
  internals.store = store;
  t.mock.method(db, 'getTasksByUser', async (userId: number, limit: number) => {
    assert.equal(userId, 4242);
    assert.equal(limit, 20);
    return [];
  });
  const daily = await store.createReminder({
    userId: 4242,
    text: 'Daily <report> & review',
    frequency: 'daily',
    timeOfDay: '22:00',
    nextRunAt: '2026-10-05T14:00:00.000Z',
  });
  const cancelled = await store.createReminder({
    userId: 4242, text: 'Cancelled schedule', frequency: 'weekly',
    nextRunAt: '2026-10-06T14:00:00.000Z',
  });
  await store.cancelReminder(cancelled.id, 4242);
  await store.createReminder({
    userId: 9999, text: 'Another user schedule', frequency: 'daily',
    nextRunAt: '2026-10-05T14:00:00.000Z',
  });

  await t.test('cron-only users see their active schedule and local next run', async () => {
    apiCalls.length = 0;
    await sendText('/tasks');
    assert.match(allMessages(), /Active reminders \(1\)/);
    assert.match(allMessages(), /Daily &lt;report&gt; &amp; review/);
    assert.match(allMessages(), /\(daily\)/);
    assert.match(allMessages(), /Asia\/Singapore/);
    assert.match(allMessages(), /22:00/);
    assert.doesNotMatch(allMessages(), /You have no|Cancelled schedule|Another user schedule/);
    assert.deepEqual(await store.listReminders(4242), [daily], 'listing does not modify the schedule');
  });

  await t.test('/task -read all uses the same schedule-aware list', async () => {
    apiCalls.length = 0;
    await sendText('/task -read all');
    assert.match(allMessages(), /Active reminders \(1\)/);
    assert.match(allMessages(), /Daily &lt;report&gt;/);
  });

  await t.test('todos retain their completion buttons beside reminders', async (subtest) => {
    subtest.mock.method(db, 'getTasksByUser', async () => [{
      id: 42, user_id: 4242, name: 'Buy milk', description: 'Groceries',
      completed: false, created_at: '2026-10-04T14:00:00.000Z',
    }]);
    apiCalls.length = 0;
    await sendText('/tasks');
    assert.match(allMessages(), /Buy milk/);
    assert.match(allMessages(), /Daily &lt;report&gt;/);
    const todoReply = apiCalls.find((call) => String(call.payload.text).includes('Buy milk'));
    assert.match(JSON.stringify(todoReply?.payload.reply_markup), /task:complete:42/);
    const remindersReply = apiCalls.find((call) => String(call.payload.text).includes('Active reminders'));
    assert.equal(remindersReply?.payload.reply_markup, undefined);
  });

  await t.test('a todo query failure does not hide active schedules', async (subtest) => {
    subtest.mock.method(db, 'getTasksByUser', async () => { throw new Error('todo database unavailable'); });
    apiCalls.length = 0;
    await sendText('/tasks');
    assert.match(allMessages(), /Failed to fetch todos/);
    assert.match(allMessages(), /Daily &lt;report&gt;/);
  });

  await t.test('a reminder query failure is reported rather than claiming there are no tasks', async (subtest) => {
    subtest.mock.method(store, 'listReminders', async () => { throw new Error('reminder database unavailable'); });
    apiCalls.length = 0;
    await sendText('/tasks');
    assert.match(allMessages(), /Failed to fetch active reminders/);
    assert.doesNotMatch(allMessages(), /You have no/);
  });

  await t.test('long reminder lists arrive in messages within the Telegram limit', async () => {
    await store.createReminder({
      userId: 4242, text: 'Long schedule '.repeat(800), frequency: 'weekly',
      nextRunAt: '2026-10-06T14:00:00.000Z',
    });
    apiCalls.length = 0;
    await sendText('/tasks');
    assert.ok(messages().length > 1);
    for (const message of messages()) {
      assert.ok(message.replace(/<[^>]+>|&(?:lt|gt|amp);/g, '').length <= 4096);
    }
    assert.match(allMessages(), /\(weekly\)/);
  });

  await t.test('the empty response applies only when both sources are empty', async () => {
    internals.store = new InMemoryAssistantStore();
    apiCalls.length = 0;
    await sendText('/tasks');
    assert.match(lastMessage(), /no todos or active reminders/);
  });
});
