import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Context, Telegraf } from 'telegraf';
import type { Prompt } from '../src/services/database.js';
import type { AssistantService } from '../src/services/assistant.js';
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
const { db } = await import('../src/services/database.js');
const { promptCommand, promptTextInputHandler, promptPhotoInputHandler, cancelPromptFlow } = await import('../src/commands/prompt.js');
const { getPromptCommand, getPromptActionHandler } = await import('../src/commands/getprompt.js');
const { registerAssistantCommands } = await import('../src/commands/assistant-commands.js');

let nextUserId = 9000;
interface Sent {
  method: string;
  chatId: number;
  text: string;
}

function context(userId: number, chatId: number, text: string, sent: Sent[], photo = false): Context {
  const reply = async (value: string) => {
    sent.push({ method: 'message', chatId, text: value });
    return { message_id: sent.length, chat: { id: chatId }, date: 1, text: value };
  };
  return {
    from: { id: userId },
    chat: { id: chatId },
    message: photo ? { photo: [{ file_id: 'small' }, { file_id: 'full' }] } : { text },
    reply,
    replyWithPhoto: async (_file: string, options: { caption: string }) => {
      sent.push({ method: 'photo', chatId, text: options.caption });
      return { message_id: 42, chat: { id: chatId } };
    },
    sendChatAction: async () => true,
    answerCbQuery: async () => true,
    telegram: {
      editMessageMedia: async (target: number, _id: number, _inline: unknown, media: { caption: string }) => {
        sent.push({ method: 'editPhoto', chatId: target, text: media.caption });
        return true;
      },
      sendMessage: async (target: number, value: string) => {
        sent.push({ method: 'message', chatId: target, text: value });
        return true;
      },
    },
  } as unknown as Context;
}

async function imageDraft(t: TestContext, sent: Sent[], title = 'Private title') {
  const userId = nextUserId++;
  t.after(() => cancelPromptFlow(userId));
  await promptCommand(context(userId, userId, '/prompt', sent));
  for (const value of [title, 'Private prompt text', 'personal']) {
    assert.equal(await promptTextInputHandler(context(userId, userId, value, sent)), true);
  }
  return userId;
}

function visible(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function assertValidOutput(sent: Sent[]): void {
  for (const item of sent) {
    const limit = item.method === 'message' ? 4096 : 1024;
    assert.ok(visible(item.text).length <= limit, `${item.method} exceeded ${limit} characters`);
    assert.doesNotMatch(item.text, /&(?!amp;|lt;|gt;|quot;|#39;)/, 'HTML entity was cut');
    assert.doesNotMatch(item.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'Unicode character was cut');
  }
}

test('private prompt drafts ignore text and photos received in another chat', async (t) => {
  const sent: Sent[] = [];
  const userId = nextUserId++;
  t.after(() => cancelPromptFlow(userId));
  const saved: unknown[][] = [];
  t.mock.method(db, 'savePrompt', async (...args: unknown[]) => { saved.push(args); });
  await promptCommand(context(userId, userId, '/prompt', sent));
  await promptTextInputHandler(context(userId, userId, 'Private title', sent));
  assert.equal(await promptTextInputHandler(context(userId, -100, 'Unrelated group message', sent)), false);
  await promptTextInputHandler(context(userId, userId, 'Private body', sent));
  await promptTextInputHandler(context(userId, userId, 'skip', sent));
  assert.equal(await promptPhotoInputHandler(context(userId, -100, '', sent, true)), false);
  assert.deepEqual(saved, []);
  assert.ok(sent.every(item => item.chatId === userId));
  await promptPhotoInputHandler(context(userId, userId, '', sent, true));
  assert.deepEqual(saved, [[userId, 'Private title', 'Private body', [], 'full']]);
});

test('concurrent album photos save one prompt and acknowledge it once', async (t) => {
  const sent: Sent[] = [];
  const userId = await imageDraft(t, sent);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  t.mock.method(db, 'savePrompt', async () => { writes++; entered(); await gate; });
  const first = promptPhotoInputHandler(context(userId, userId, '', sent, true));
  await started;
  try {
    assert.equal(await promptPhotoInputHandler(context(userId, userId, '', sent, true)), true);
    assert.equal(writes, 1);
  } finally {
    release();
    await first;
  }
  assert.equal(sent.filter(item => /saved successfully/.test(item.text)).length, 1);
});

test('a failed prompt insert remains retryable, but a failed acknowledgement does not', async (t) => {
  const sent: Sent[] = [];
  const userId = await imageDraft(t, sent);
  let writes = 0;
  t.mock.method(db, 'savePrompt', async () => { if (++writes === 1) throw new Error('Database unavailable'); });
  await promptPhotoInputHandler(context(userId, userId, '', sent, true));
  const ctx = context(userId, userId, '', sent, true);
  ctx.reply = async () => { throw new Error('Telegram unavailable'); };
  assert.equal(await promptPhotoInputHandler(ctx), true);
  assert.equal(await promptPhotoInputHandler(context(userId, userId, '', sent, true)), false);
  assert.equal(writes, 2, 'one failed insert and one successful insert');
});

test('saving an older prompt does not discard a newly opened prompt draft', async (t) => {
  const sent: Sent[] = [];
  const userId = await imageDraft(t, sent);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(db, 'savePrompt', async () => { await gate; });
  const first = promptPhotoInputHandler(context(userId, userId, '', sent, true));
  await promptCommand(context(userId, userId, '/prompt', sent));
  release();
  await first;
  assert.equal(await promptTextInputHandler(context(userId, userId, 'New title', sent)), true);
  assert.match(sent.at(-1)!.text, /Prompt text/);
});

function savedPrompt(userId: number, id: number): Prompt {
  return {
    id, user_id: userId, title: `<&😀>TITLE${id}`.repeat(170),
    prompt: `<&😀>BODY${id}`.repeat(600), tags: [`long-tag-${id}`.repeat(150)],
    image_file_id: `image-${id}`, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  };
}

test('long prompt titles, tags and bodies remain complete on search and pagination', async (t) => {
  const sent: Sent[] = [];
  const userId = nextUserId++;
  const results = [savedPrompt(userId, 1), savedPrompt(userId, 2)];
  t.mock.method(db, 'searchPrompts', async () => results);
  await getPromptCommand(context(userId, userId, '/getprompt -title example', sent));
  assert.equal(sent[0].method, 'photo');
  assertValidOutput(sent);
  let full = sent.filter(item => item.method === 'message').map(item => visible(item.text)).join('');
  assert.ok(full.includes(results[0].title));
  assert.ok(full.includes(results[0].tags[0]));
  assert.ok(full.includes(results[0].prompt));
  sent.length = 0;
  const ctx = context(userId, userId, '', sent);
  Object.assign(ctx, { callbackQuery: { data: 'getprompt:next', message: { message_id: 42, chat: { id: userId } } } });
  await getPromptActionHandler(ctx);
  assert.equal(sent[0].method, 'editPhoto');
  assertValidOutput(sent);
  full = sent.filter(item => item.method === 'message').map(item => visible(item.text)).join('');
  assert.ok(full.includes(results[1].title));
  assert.ok(full.includes(results[1].tags[0]));
  assert.ok(full.includes(results[1].prompt));
});

test('/memory chunks large saved facts and reminders without losing entries', async () => {
  const store = new InMemoryAssistantStore();
  const userId = nextUserId++;
  for (let i = 0; i < 40; i++) await store.saveFact(userId, `fact_${i}`, `${i}:` + 'x'.repeat(100));
  for (let i = 0; i < 20; i++) await store.createReminder({ userId, text: `reminder_${i}:` + 'y'.repeat(100), frequency: 'once', nextRunAt: '2099-01-01T00:00:00Z' });
  const handlers = new Map<string, (ctx: Context) => Promise<void>>();
  const bot = { command: (name: string, handler: (ctx: Context) => Promise<void>) => handlers.set(name, handler) } as unknown as Telegraf;
  registerAssistantCommands(bot, { getStore: () => store } as unknown as AssistantService, 'Asia/Singapore');
  const sent: Sent[] = [];
  await handlers.get('memory')!(context(userId, userId, '/memory', sent));
  assert.ok(sent.length > 1);
  assertValidOutput(sent);
  const full = sent.map(item => visible(item.text)).join('');
  for (let i = 0; i < 40; i++) assert.ok(full.includes(`${i}:` + 'x'.repeat(100)));
  for (let i = 0; i < 20; i++) assert.ok(full.includes(`reminder_${i}:` + 'y'.repeat(100)));
});
