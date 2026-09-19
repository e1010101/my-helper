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
  await sendText('hello there');
  assert.match(lastMessage(), /having trouble/i);
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
      getHealthStatus(): Promise<Record<string, unknown>>;
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
    healthService.getHealthStatus = async () => ({
      status: 'unhealthy',
      bot: { connected: true, mode: 'webhook' },
      database: { connected: false, error: 'cannot write to the assistant tables' },
    });

    const healthDown = await status('/health');
    assert.equal(healthDown.code, 200, 'liveness must pass while the bot can still serve');
    assert.equal(healthDown.body.check, 'health');

    const readyDown = await status('/ready');
    assert.equal(readyDown.code, 503, 'readiness must fail while the database is unusable');
    assert.equal(readyDown.body.check, 'ready');

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
