/**
 * Tests for the usage dashboard.
 *
 * The security assertions matter most here: this is the only route that returns
 * personal data, on a domain anyone can resolve. It must fail closed when no
 * token is configured, and must not accept a wrong or partial token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env.NODE_ENV = 'production';
process.env.TELEGRAM_BOT_TOKEN = '123456:FAKE';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'k';
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'k';
delete process.env.GEMINI_API_KEY;
process.env.ADMIN_USER_ID = '4242';
delete process.env.WEBHOOK_DOMAIN;

const { Bot, isAuthorised } = await import('../src/bot.js');
const { InMemoryAssistantStore } = await import('../src/services/in-memory-assistant-store.js');
const { renderDashboard } = await import('../src/utils/dashboard.js');

// --- Token comparison ------------------------------------------------------

function fakeRequest(url: string, authorization?: string): IncomingMessage {
  return { url, headers: authorization ? { authorization } : {} } as IncomingMessage;
}

test('a correct token in the query string is accepted', () => {
  assert.equal(isAuthorised(fakeRequest('/dashboard?token=s3cret'), 's3cret'), true);
});

test('a correct token as a bearer header is accepted', () => {
  assert.equal(isAuthorised(fakeRequest('/dashboard', 'Bearer s3cret'), 's3cret'), true);
});

test('a missing token is rejected', () => {
  assert.equal(isAuthorised(fakeRequest('/dashboard'), 's3cret'), false);
});

test('a wrong token is rejected', () => {
  assert.equal(isAuthorised(fakeRequest('/dashboard?token=wrong'), 's3cret'), false);
});

test('a correct prefix is rejected', () => {
  // Guards the truncation bug that a length check alone would not catch if the
  // comparison were done on padded buffers.
  assert.equal(isAuthorised(fakeRequest('/dashboard?token=s3cre'), 's3cret'), false);
});

test('a longer token is rejected without throwing', () => {
  // timingSafeEqual throws on unequal lengths, which must not surface as a 500.
  assert.equal(isAuthorised(fakeRequest('/dashboard?token=s3cret-and-more'), 's3cret'), false);
});

test('other query parameters do not leak a token in', () => {
  assert.equal(isAuthorised(fakeRequest('/dashboard?days=30&token='), 's3cret'), false);
  assert.equal(isAuthorised(fakeRequest('/dashboard?tokenName=s3cret'), 's3cret'), false);
});

// --- Rendering -------------------------------------------------------------

function data(overrides: Partial<Parameters<typeof renderDashboard>[0]> = {}) {
  const base = {
    summary: {
      calls: 12,
      promptTokens: 12_000,
      completionTokens: 900,
      totalTokens: 12_900,
      cachedTokens: 6_000,
      averagePromptTokens: 1_000,
      firstRecordedAt: '2026-09-01T00:00:00Z',
      lastRecordedAt: '2026-09-02T00:00:00Z',
    },
    daily: [
      { date: '2026-09-01', calls: 6, promptTokens: 5_400, completionTokens: 400, totalTokens: 5_800, cachedTokens: 2_000, averagePromptTokens: 900, averageSystemTokens: 150, averageToolsTokens: 700, averageMessagesTokens: 50 },
      { date: '2026-09-02', calls: 6, promptTokens: 6_600, completionTokens: 500, totalTokens: 7_100, cachedTokens: 4_000, averagePromptTokens: 1_100, averageSystemTokens: 160, averageToolsTokens: 700, averageMessagesTokens: 240 },
    ],
    windowDays: 30,
    timezone: 'Asia/Singapore',
    generatedAt: new Date('2026-09-02T12:00:00Z'),
  };
  return { ...base, ...overrides };
}

test('the dashboard renders the headline numbers', () => {
  const html = renderDashboard(data());

  assert.match(html, /<title>Assistant usage<\/title>/);
  assert.match(html, /12/, 'call count');
  assert.match(html, /12\.9k/, 'total tokens, compacted');
  assert.match(html, /50%/, 'cache share');
  assert.match(html, /Asia\/Singapore/);
});

test('it plots a trend and labels the direction', () => {
  const html = renderDashboard(data());

  assert.match(html, /<svg/);
  assert.match(html, /\+200 tokens vs the first day/, '900 -> 1100 is a rise');
});

test('a falling prompt size is labelled as falling, not just different', () => {
  const falling = data();
  falling.daily = [falling.daily[1], falling.daily[0]]; // reverse to descend
  const html = renderDashboard(falling);

  assert.match(html, /-200 tokens vs the first day/);
});

test('with fewer than two days it says so instead of drawing a line', () => {
  // A single point is not a trend; drawing one would imply a direction that is
  // not there.
  const html = renderDashboard(data({ daily: [data().daily[0]] }));

  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /Not enough days/);
});

test('an empty window says there is nothing yet', () => {
  const html = renderDashboard(data({
    daily: [],
    summary: {
      calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
      averagePromptTokens: 0, firstRecordedAt: null, lastRecordedAt: null,
    },
  }));

  assert.match(html, /No usage recorded/);
  assert.doesNotMatch(html, /NaN/);
});

test('the newest day appears first in the table', () => {
  const html = renderDashboard(data());

  // Scope to the table body: the sparkline axis also contains both dates, so a
  // bare indexOf would compare the wrong occurrences.
  const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const newest = tbody.indexOf('2026-09-02');
  const oldest = tbody.indexOf('2026-09-01');

  assert.notEqual(newest, -1, 'the newest day is present');
  assert.notEqual(oldest, -1, 'the oldest day is present');
  assert.ok(newest < oldest, 'most recent day should be listed first');
});

test('a zero-token window does not report a NaN cache share', () => {
  const html = renderDashboard(data({
    summary: {
      calls: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
      averagePromptTokens: 0, firstRecordedAt: null, lastRecordedAt: null,
    },
  }));

  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
});

test('the page cannot be cached or indexed', () => {
  // Both are asserted on the response in the route tests; here we check the
  // document itself asks not to be indexed.
  assert.match(renderDashboard(data()), /noindex/);
});

// --- Route: what the caller actually gets ----------------------------------

interface Captured {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '', headers: {} };
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      captured.status = code;
      Object.assign(captured.headers, headers ?? {});
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return this;
    },
  } as unknown as ServerResponse;

  return { res, captured };
}

/** Invokes the private route handler directly, with a store we control. */
async function hitRoute(
  url: string,
  store: unknown,
  authorization?: string
): Promise<Captured> {
  const bot = new Bot();
  const { res, captured } = fakeResponse();
  const internals = bot as unknown as {
    handleDashboardRequest(
      req: IncomingMessage,
      res: ServerResponse,
      store?: unknown
    ): Promise<void>;
  };

  await internals.handleDashboardRequest(fakeRequest(url, authorization), res, store);
  bot.dispose();
  return captured;
}

test('with no token configured the route does not exist', async () => {
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.WEBHOOK_SECRET;

  const captured = await hitRoute('/dashboard', new InMemoryAssistantStore());

  // Failing closed matters more than a helpful message: 404 reveals nothing,
  // and there is no configuration in which serving this unauthenticated is right.
  assert.equal(captured.status, 404);
});

test('a 401 is returned for a missing token, with no data in the body', async () => {
  process.env.DASHBOARD_TOKEN = 'letmein';

  const captured = await hitRoute('/dashboard', new InMemoryAssistantStore());

  assert.equal(captured.status, 401);
  assert.doesNotMatch(captured.body, /Assistant usage/);
});

test('a 401 is returned for a wrong token', async () => {
  process.env.DASHBOARD_TOKEN = 'letmein';

  const captured = await hitRoute('/dashboard?token=nope', new InMemoryAssistantStore());

  assert.equal(captured.status, 401);
});

test('an authorised request renders usage from the store', async () => {
  process.env.DASHBOARD_TOKEN = 'letmein';
  const store = new InMemoryAssistantStore();
  await store.recordTokenUsage({
    userId: 4242,
    provider: 'test',
    model: 'test-model',
    promptTokens: 1200,
    completionTokens: 30,
    totalTokens: 1230,
    cachedTokens: 800,
    systemTokens: 200,
    toolsTokens: 900,
    messagesTokens: 100,
    iteration: 0,
  });

  const captured = await hitRoute('/dashboard?token=letmein', store);

  assert.equal(captured.status, 200);
  assert.match(captured.body, /Assistant usage/);
  assert.match(captured.body, /1\.2k/, 'the recorded prompt average appears');
  assert.equal(captured.headers['Cache-Control'], 'no-store');
  assert.equal(captured.headers['Referrer-Policy'], 'no-referrer');
});

test('a working WEBHOOK_SECRET also unlocks it, so one secret suffices', async () => {
  delete process.env.DASHBOARD_TOKEN;
  process.env.WEBHOOK_SECRET = 'webhook-secret';

  const captured = await hitRoute('/dashboard?token=webhook-secret', new InMemoryAssistantStore());

  assert.equal(captured.status, 200);

  delete process.env.WEBHOOK_SECRET;
});

test('a store failure returns 500 rather than a half-rendered page', async () => {
  process.env.DASHBOARD_TOKEN = 'letmein';
  const broken = new InMemoryAssistantStore();
  broken.summariseTokenUsage = async () => {
    throw new Error('database down');
  };

  const captured = await hitRoute('/dashboard?token=letmein', broken);

  assert.equal(captured.status, 500);
  assert.doesNotMatch(captured.body, /Assistant usage/);
});
