/**
 * Webhook-mode tests.
 *
 * These cover the one code path that only runs in production. A flaw here is
 * invisible until the bot is live, and the failure mode is worse than a crash:
 * an unauthenticated endpoint lets anyone who learns the URL drive the
 * assistant with forged updates.
 *
 * The real createWebhook() is used, because its request filter is exactly what
 * is under test. Only the Telegram HTTP layer is stubbed, since registering a
 * real webhook would point Telegram at a local address.
 *
 * Note that a failed filter yields HTTP 403 from Telegraf's adapter either way,
 * so the status code proves nothing; the assertion that matters is whether the
 * update reached the bot's handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

process.env.NODE_ENV = 'production'; // keep the logger quiet
process.env.TELEGRAM_BOT_TOKEN = '123456:FAKE_TOKEN_FOR_TESTS';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'fake-deepseek-key';
delete process.env.GEMINI_API_KEY;
process.env.ADMIN_USER_ID = '4242';
process.env.TIMEZONE = 'Asia/Singapore';

// Webhook mode, with a secret we control.
process.env.WEBHOOK_DOMAIN = 'example.invalid';
process.env.WEBHOOK_PORT = '3397';
process.env.WEBHOOK_SECRET = 'test-secret-token';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const PORT = 3397;

const require = createRequire(import.meta.url);
const ApiClientPath = join(dirname(require.resolve('telegraf')), 'core', 'network', 'client.js');
const { default: ApiClient } = require(ApiClientPath) as {
  default: { prototype: { callApi(method: string, payload: unknown): Promise<unknown> } };
};

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const apiCalls: ApiCall[] = [];

ApiClient.prototype.callApi = async function (method: string, payload: unknown) {
  const record = (payload ?? {}) as Record<string, unknown>;
  apiCalls.push({ method, payload: record });

  if (method === 'getMe') {
    return { id: 1, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  }
  if (method === 'sendMessage' || method === 'sendPhoto') {
    return {
      message_id: apiCalls.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: record.chat_id, type: 'private' },
      text: String(record.text ?? ''),
    };
  }
  return { ok: true };
};

const { Bot } = await import('../src/bot.js');

interface FakeResponse {
  statusCode: number;
  body: string;
  writeHead(code: number): FakeResponse;
  end(chunk?: string): void;
  writableEnded: boolean;
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    body: '',
    writableEnded: false,
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
    },
  };
}

/** A plausible forged update, as an attacker would post it. */
function spoofedUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 4242, type: 'private' },
      from: { id: 4242, is_bot: false, first_name: 'Owner', username: 'owner' },
      text: '/ping',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  };
}

test('webhook requests without the secret token are rejected and never handled', async () => {
  const bot = new Bot();
  const telegraf = bot.getBot();

  // Count how many updates actually reach the bot, which is the real question.
  let handled = 0;
  const realHandleUpdate = telegraf.handleUpdate.bind(telegraf);
  (telegraf as unknown as { handleUpdate(u: unknown, r?: unknown): Promise<void> }).handleUpdate =
    async (update: unknown, response?: unknown) => {
      handled += 1;
      return realHandleUpdate(update as never, response as never);
    };

  // Capture the options start() passes and the handler it receives, so this
  // test exercises production's own callback rather than a fresh one.
  const realWebhookCallback = telegraf.webhookCallback.bind(telegraf);
  const callbackOptions: Record<string, unknown>[] = [];
  let productionCallback: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  (telegraf as unknown as {
    webhookCallback(p: string, o?: Record<string, unknown>): unknown;
  }).webhookCallback = (path: string, options?: Record<string, unknown>) => {
    callbackOptions.push(options ?? {});
    productionCallback = realWebhookCallback(path, options as never) as unknown as (
      req: unknown,
      res: unknown
    ) => Promise<void>;
    return productionCallback;
  };

  await bot.start();

  try {
    // 1. The handler must be built with the secret in hand.
    assert.equal(callbackOptions.length, 1, 'webhookCallback was called once');
    assert.equal(
      callbackOptions[0].secretToken,
      process.env.WEBHOOK_SECRET,
      'production must pass secretToken to webhookCallback, or the filter allows everything'
    );

    // 2. Telegram must be told to sign requests with the same secret.
    const setWebhookCall = apiCalls.find((call) => call.method === 'setWebhook');
    assert.ok(setWebhookCall, 'the webhook URL was registered with Telegram');
    assert.equal(setWebhookCall.payload.secret_token, process.env.WEBHOOK_SECRET);
    assert.equal(setWebhookCall.payload.url, 'https://example.invalid/webhook');

    // 3. Drive the exact handler production built.
    assert.ok(productionCallback, 'start() produced a request handler');
    const callback = productionCallback;

    const invoke = async (headers: Record<string, string>) => {
      const res = fakeResponse();
      const req = {
        method: 'POST',
        url: '/webhook',
        headers,
        body: spoofedUpdate(),
        async *[Symbol.asyncIterator]() {
          /* body already provided */
        },
      };
      await callback(req as never, res as never);
      return res;
    };

    handled = 0;

    // No header — the forged request Telegram never sent.
    await invoke({});
    assert.equal(handled, 0, 'an unsigned request must not reach the handler');

    // Wrong secret.
    await invoke({ [SECRET_HEADER]: 'not-the-secret' });
    assert.equal(handled, 0, 'a request with the wrong secret must not reach the handler');

    // The genuine request.
    await invoke({ [SECRET_HEADER]: process.env.WEBHOOK_SECRET! });
    assert.equal(handled, 1, 'a correctly signed request must be handled');
  } finally {
    bot.dispose();
    await bot.stop('test');
    void PORT;
  }
});
