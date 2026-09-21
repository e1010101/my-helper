/**
 * Tests for the command catalog.
 *
 * The catalog exists to stop three things disagreeing: Telegram's command menu,
 * the /help text, and the commands actually registered with Telegraf. These
 * tests check the catalog against the real bot, because a menu entry for a
 * command that does not exist is worse than no menu at all — the user taps it
 * and nothing happens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, commandsFor, renderHelpText, toBotCommands } from '../src/commands/catalog.js';

process.env.NODE_ENV = 'production';
process.env.TELEGRAM_BOT_TOKEN = '123456:FAKE';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'k';
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'k';
delete process.env.GEMINI_API_KEY;
process.env.ADMIN_USER_ID = '4242';

const { registerCommands } = await import('../src/commands/index.js');
const { registerAssistantCommands } = await import('../src/commands/assistant-commands.js');
const { AssistantService } = await import('../src/services/assistant.js');
const { InMemoryAssistantStore } = await import('../src/services/in-memory-assistant-store.js');

/** Collects the command names a bot instance actually registers. */
function registeredNames(): Set<string> {
  const store = new InMemoryAssistantStore();
  const assistant = new AssistantService({
    store,
    // Empty registry: this test is about command wiring, not tools.
    registry: { list: () => [], toFunctionDeclarations: () => [] } as never,
    client: {
      name: 'noop',
      model: 'noop',
      generate: async () => ({ text: '', toolCalls: [] }),
      generateText: async () => '',
    },
    timezone: 'UTC',
  });

  const names = new Set<string>();
  const fakeBot = {
    command: (name: string) => {
      names.add(name);
    },
    action: () => undefined,
    on: () => undefined,
  };

  registerCommands(fakeBot as never);
  registerAssistantCommands(fakeBot as never, assistant, 'UTC');
  return names;
}

test('every catalogued command is actually registered', () => {
  const registered = registeredNames();
  const catalogued = COMMANDS.map((command) => command.name);

  const missing = catalogued.filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], `catalogued but not registered: ${missing.join(', ')}`);
});

test('every registered command appears in the menu', () => {
  // The reverse direction: a command that exists but is invisible in the menu
  // is undiscoverable, which is the problem this whole change solves.
  const registered = registeredNames();
  const catalogued = new Set(COMMANDS.map((command) => command.name));

  const undocumented = [...registered].filter((name) => !catalogued.has(name));
  assert.deepEqual(undocumented, [], `registered but not in the menu: ${undocumented.join(', ')}`);
});

test("descriptions satisfy Telegram's limits", () => {
  for (const command of COMMANDS) {
    assert.ok(
      command.description.length >= 3 && command.description.length <= 256,
      `"${command.name}" description is ${command.description.length} chars, outside 3-256`
    );
  }
});

test('command names are valid for Telegram', () => {
  for (const command of COMMANDS) {
    // Telegram requires lowercase letters, digits and underscores, 1-32 chars.
    assert.match(command.name, /^[a-z0-9_]{1,32}$/, `invalid command name: ${command.name}`);
  }
});

test('command names are unique', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, 'duplicate command name in the catalog');
});

test('the default menu excludes admin commands', () => {
  const names = toBotCommands(false).map((command) => command.command);

  assert.ok(!names.includes('status'), 'admin commands must not appear for everyone');
  assert.ok(!names.includes('stats'));
  assert.ok(names.includes('help'), 'ordinary commands are still listed');
});

test('the admin menu includes everything', () => {
  const names = toBotCommands(true).map((command) => command.command);

  assert.ok(names.includes('status'));
  assert.ok(names.includes('stats'));
  assert.equal(names.length, COMMANDS.length);
});

test('commandsFor(true) is a superset of commandsFor(false)', () => {
  const regular = new Set(commandsFor(false).map((command) => command.name));
  const all = new Set(commandsFor(true).map((command) => command.name));

  for (const name of regular) {
    assert.ok(all.has(name), `${name} missing from the admin set`);
  }
});

test('the shape matches what setMyCommands expects', () => {
  for (const entry of toBotCommands(true)) {
    assert.deepEqual(Object.keys(entry).sort(), ['command', 'description']);
    assert.equal(typeof entry.command, 'string');
    assert.equal(typeof entry.description, 'string');
  }
});

test('the help text lists every command, with admin split out', () => {
  const admin = renderHelpText(true);
  const user = renderHelpText(false);

  for (const command of COMMANDS) {
    assert.match(admin, new RegExp(`/${command.name}\\b`), `${command.name} missing from admin help`);
  }

  // A normal user sees no admin section at all, rather than an empty heading.
  assert.doesNotMatch(user, /Admin Commands:/);
  assert.doesNotMatch(user, /\/status/);
  assert.doesNotMatch(user, /\/stats/);
  assert.match(user, /\/help\b/, 'ordinary commands are still listed');
});

test('the help text keeps usage details for commands that take flags', () => {
  const help = renderHelpText(true);

  // A one-line menu description cannot carry flags; dropping them would make
  // /help strictly less useful than the text it replaced.
  assert.match(help, /-create/);
  assert.match(help, /-read <id>/);
  assert.match(help, /-update <id>/);
  assert.match(help, /-delete <id>/);
  assert.match(help, /-title <text>/);
  assert.match(help, /-tag <tag1,tag2>/);
});

test('the help text mentions plain text, which is most of the bot', () => {
  assert.match(renderHelpText(false), /plain text/);
});
