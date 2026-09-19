import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AssistantService } from '../src/services/assistant.js';
import type { AIClient, AgentMessage, ModelTurn } from '../src/services/ai-client.js';
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import { createDefaultToolRegistry } from '../src/tools/builtin-tools.js';
import { localKey } from '../src/services/reminder-time.js';
import type { ToolRegistry } from '../src/tools/registry.js';

const SINGAPORE = 'Asia/Singapore';
const NOW = new Date('2026-03-10T01:00:00Z'); // 09:00 in Singapore

/** A model turn that only calls functions. */
function callTurn(...calls: { id: string; name: string; args?: Record<string, unknown> }[]): ModelTurn {
  return {
    text: '',
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name, args: call.args ?? {} })),
  };
}

function textTurn(text: string): ModelTurn {
  return { text, toolCalls: [] };
}

/**
 * Asserts the conversation is well-formed for any chat API: every tool result
 * must answer a preceding assistant tool call.
 *
 * This mirrors the validation DeepSeek and OpenAI apply (and that Gemini
 * enforces with its own error). Without it a malformed conversation passes
 * every fake-client test and fails only against the real provider.
 */
function assertValidConversation(messages: AgentMessage[]): void {
  const openCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        openCallIds.add(call.id);
      }
      continue;
    }

    if (message.role === 'tool') {
      assert.ok(
        openCallIds.has(message.toolCallId),
        `tool message "${message.toolCallId}" has no preceding assistant tool_calls entry`
      );
      openCallIds.delete(message.toolCallId);
    }
  }
}

/** Scripted AI client that records what it was asked. */
class FakeClient implements AIClient {
  readonly name = 'fake';
  readonly calls: AgentMessage[][] = [];
  readonly systemInstructions: (string | undefined)[] = [];

  constructor(private readonly script: ModelTurn[]) {}

  async generate(
    messages: AgentMessage[],
    _registry?: unknown,
    systemInstruction?: string
  ): Promise<ModelTurn> {
    assertValidConversation(messages);
    this.calls.push(structuredClone(messages));
    this.systemInstructions.push(systemInstruction);
    const next = this.script.shift();
    if (!next) {
      throw new Error('FakeClient ran out of scripted turns');
    }
    return next;
  }

  async generateText(): Promise<string> {
    return '';
  }
}

function makeService(script: ModelTurn[], registry: ToolRegistry = createDefaultToolRegistry()) {
  const store = new InMemoryAssistantStore();
  const client = new FakeClient(script);
  const service = new AssistantService({
    store,
    registry,
    client,
    timezone: SINGAPORE,
    now: () => NOW,
  });
  return { store, client, service };
}

/** Tool results the loop fed back to the model. */
function toolResults(messages: AgentMessage[]): { toolCallId: string; content: string; isError?: boolean }[] {
  return messages.filter(
    (message): message is Extract<AgentMessage, { role: 'tool' }> => message.role === 'tool'
  );
}

test('a plain reply is returned and both turns are persisted', async () => {
  const { service, store } = makeService([textTurn('Hello there!')]);

  const reply = await service.processMessage(1, 'hi');

  assert.equal(reply.kind, 'message');
  assert.equal(reply.kind === 'message' && reply.text, 'Hello there!');

  const history = await store.getRecentMessages(1, 10);
  assert.deepEqual(
    history.map((message) => [message.role, message.content]),
    [
      ['user', 'hi'],
      ['model', 'Hello there!'],
    ]
  );
});

test('read tools run inline and their output is fed back to the model', async () => {
  const { service, client } = makeService([
    callTurn({ id: 'c1', name: 'current_time' }),
    textTurn('It is nine in the morning.'),
  ]);

  const reply = await service.processMessage(1, 'what time is it?');

  assert.equal(reply.kind === 'message' && reply.text, 'It is nine in the morning.');
  assert.equal(client.calls.length, 2, 'the loop ran a second model pass');

  const [payload] = toolResults(client.calls[1]);
  assert.ok(payload, 'a tool result was sent back');
  assert.match(payload.content, /2026/);
});

test('a write tool does not execute until it is confirmed', async () => {
  const { service, store, client } = makeService([
    callTurn({
      id: 'c1',
      name: 'save_fact',
      args: { key: 'home_city', value: 'Singapore' },
    }),
  ]);

  const reply = await service.processMessage(1, 'remember I live in Singapore');

  assert.equal(reply.kind, 'confirmation');
  if (reply.kind !== 'confirmation') return;

  assert.equal(reply.confirmation.toolName, 'save_fact');
  assert.match(reply.confirmation.summary, /home_city/);

  // Nothing was written, and the model was not consulted again.
  assert.equal(await store.getFact(1, 'home_city'), null);
  assert.equal(client.calls.length, 1);
});

test('confirming a write tool executes it and clears the pending action', async () => {
  const { service, store } = makeService([
    callTurn({ id: 'c1', name: 'save_fact', args: { key: 'home_city', value: 'Singapore' } }),
    textTurn('Noted.'),
  ]);

  const first = await service.processMessage(1, 'remember I live in Singapore');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  // Still pending before approval.
  assert.equal(await store.getPendingAction(first.confirmation.id, 1) !== null, true);

  const second = await service.approvePendingAction(1, first.confirmation.id);

  assert.equal(second.kind === 'message' && second.text, 'Noted.');
  const fact = await store.getFact(1, 'home_city');
  assert.equal(fact?.value, 'Singapore');
  assert.equal(await store.getPendingAction(first.confirmation.id, 1), null);
});

test('rejecting a confirmation changes nothing', async () => {
  const { service, store } = makeService([
    callTurn({ id: 'c1', name: 'save_fact', args: { key: 'home_city', value: 'Singapore' } }),
  ]);

  const first = await service.processMessage(1, 'remember I live in Singapore');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  const reply = await service.rejectPendingAction(1, first.confirmation.id);

  assert.match(reply.kind === 'message' ? reply.text : '', /cancelled/i);
  assert.equal(await store.getFact(1, 'home_city'), null);
  assert.equal(await store.getPendingAction(first.confirmation.id, 1), null);
});

test('confirmations cannot be approved by a different user', async () => {
  const { service } = makeService([
    callTurn({ id: 'c1', name: 'save_fact', args: { key: 'k', value: 'v' } }),
  ]);

  const first = await service.processMessage(1, 'remember something');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  const reply = await service.approvePendingAction(999, first.confirmation.id);
  assert.match(reply.kind === 'message' ? reply.text : '', /expired/i);
});

test('an expired confirmation is refused', async () => {
  const store = new InMemoryAssistantStore();
  const client = new FakeClient([
    callTurn({ id: 'c1', name: 'save_fact', args: { key: 'k', value: 'v' } }),
  ]);
  let clock = new Date(NOW);
  const service = new AssistantService({
    store,
    registry: createDefaultToolRegistry(),
    client,
    timezone: SINGAPORE,
    now: () => clock,
    confirmationTtlMs: 1000,
  });

  const first = await service.processMessage(1, 'remember something');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  clock = new Date(NOW.getTime() + 5000);
  const reply = await service.approvePendingAction(1, first.confirmation.id);

  assert.match(reply.kind === 'message' ? reply.text : '', /expired/i);
  assert.equal(await store.getFact(1, 'k'), null);
});

test('create_reminder composes with the time parser', async () => {
  const { service, store } = makeService([
    callTurn({
      id: 'c1',
      name: 'create_reminder',
      args: { text: 'Call mum', when_text: 'tomorrow at 07:30' },
    }),
    textTurn('Will do.'),
  ]);

  const first = await service.processMessage(1, 'remind me to call mum tomorrow at 7:30am');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  await service.approvePendingAction(1, first.confirmation.id);

  const [reminder] = await store.listReminders(1);
  assert.equal(reminder.text, 'Call mum');
  // "tomorrow at 07:30" is resolved against the time the user asked, so it must
  // land on the next day at 07:30 local, whatever today happens to be.
  const tomorrow = new Date(Date.now() + 86_400_000);
  assert.equal(localKey(new Date(reminder.nextRunAt), SINGAPORE), `${localKey(tomorrow, SINGAPORE).slice(0, 10)}T07:30`);
});

test('an unparseable time is reported to the model without scheduling', async () => {
  const { service, store, client } = makeService([
    callTurn({ id: 'c1', name: 'create_reminder', args: { text: 'x', when_text: 'whenever' } }),
    textTurn('I need a clearer time.'),
  ]);

  const first = await service.processMessage(1, 'remind me whenever');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  await service.approvePendingAction(1, first.confirmation.id);

  assert.equal((await store.listReminders(1)).length, 0);
  const payloads = toolResults(client.calls[1]);
  assert.match(payloads[0].content, /could not understand/i);
});

test('an invalid write-tool call is reported back instead of throwing', async () => {
  const { service, client, store } = makeService([
    callTurn({ id: 'c1', name: 'save_fact', args: { key: 'k' } }), // missing required value
    textTurn('I need the value too.'),
  ]);

  const reply = await service.processMessage(1, 'remember k');

  assert.equal(reply.kind === 'message' && reply.text, 'I need the value too.');
  assert.equal(await store.getFact(1, 'k'), null, 'nothing was written');
  const payloads = toolResults(client.calls[1]);
  assert.equal(payloads[0].isError, true);
  assert.match(payloads[0].content, /Missing required parameter "value"/);
});

test('an unknown tool is surfaced to the model as an error', async () => {
  const { service, client } = makeService([
    callTurn({ id: 'c1', name: 'delete_everything' }),
    textTurn('I cannot do that.'),
  ]);

  await service.processMessage(1, 'delete everything');

  const payloads = toolResults(client.calls[1]);
  assert.match(payloads[0].content, /Unknown tool/);
});

test('a tool that throws is reported without breaking the reply', async () => {
  const registry = createDefaultToolRegistry();
  // The registry stores tool objects by reference, so replacing execute here
  // simulates a tool failing at runtime.
  registry.get('current_time')!.execute = async () => {
    throw new Error('boom');
  };

  const { service, client } = makeService(
    [callTurn({ id: 'c1', name: 'current_time' }), textTurn('That failed.')],
    registry
  );

  const reply = await service.processMessage(1, 'what time is it?');

  assert.equal(reply.kind === 'message' && reply.text, 'That failed.');
  const payloads = toolResults(client.calls[1]);
  assert.match(payloads[0].content, /failed/i);
});

test('the tool loop stops instead of spinning forever', async () => {
  // Always asks for a tool, never answers.
  const store = new InMemoryAssistantStore();
  const client: AIClient = {
    name: 'looping-fake',
    async generate() {
      return callTurn({ id: 'c', name: 'current_time' });
    },
    async generateText() {
      return '';
    },
  };

  const service = new AssistantService({
    store,
    registry: createDefaultToolRegistry(),
    client,
    timezone: SINGAPORE,
    now: () => NOW,
    maxToolIterations: 3,
  });

  const reply = await service.processMessage(1, 'loop please');

  assert.equal(reply.kind, 'message');
  assert.match(reply.kind === 'message' ? reply.text : '', /circles|rephrase/i);
});

test('history is replayed to the model on the next turn', async () => {
  const { service, client } = makeService([
    textTurn('First answer'),
    textTurn('Second answer'),
  ]);

  await service.processMessage(1, 'first question');
  await service.processMessage(1, 'second question');

  const secondRequest = client.calls[1];
  const flat = JSON.stringify(secondRequest);
  assert.match(flat, /first question/);
  assert.match(flat, /First answer/);
  assert.match(flat, /second question/);
});

test('a storage failure does not lose the reply', async () => {
  const store = new InMemoryAssistantStore();
  store.getRecentMessages = async () => {
    throw new Error('database down');
  };
  store.appendMessages = async () => {
    throw new Error('database down');
  };

  const client = new FakeClient([textTurn('Still here.')]);
  const service = new AssistantService({
    store,
    registry: createDefaultToolRegistry(),
    client,
    timezone: SINGAPORE,
    now: () => NOW,
  });

  const reply = await service.processMessage(1, 'are you there?');
  assert.equal(reply.kind === 'message' && reply.text, 'Still here.');
});

test('expired confirmations are pruned', async () => {
  const store = new InMemoryAssistantStore();
  const client = new FakeClient([
    callTurn({ id: 'c1', name: 'save_fact', args: { key: 'k', value: 'v' } }),
  ]);
  let clock = new Date(NOW);
  const service = new AssistantService({
    store,
    registry: createDefaultToolRegistry(),
    client,
    timezone: SINGAPORE,
    now: () => clock,
    confirmationTtlMs: 1000,
  });

  const reply = await service.processMessage(1, 'remember something');
  assert.equal(reply.kind, 'confirmation');

  clock = new Date(NOW.getTime() + 10_000);
  const pruned = await service.pruneExpiredConfirmations();

  assert.equal(pruned, 1);
});

test('forgetConversation clears memory but keeps facts', async () => {
  const { service, store } = makeService([textTurn('Hi!')]);

  await service.processMessage(1, 'hello');
  await store.saveFact(1, 'home_city', 'Singapore');

  await service.forgetConversation(1);

  assert.equal(await store.countMessages(1), 0);
  assert.equal((await store.getFact(1, 'home_city'))?.value, 'Singapore');
});

test('every request carries the current time in the system prompt', async () => {
  // Regression test: without this the model has no idea what time it is, and
  // answers relative questions using a stale time from earlier in the
  // conversation. NOW is 09:00 in Singapore.
  const { service, client } = makeService([textTurn('ok')]);

  await service.processMessage(1, 'what time is it?');

  const instruction = client.systemInstructions[0];
  assert.ok(instruction, 'a system instruction was sent');
  assert.match(instruction, /Current date and time:/);
  assert.match(instruction, /09:00/, 'the local time is stated');
  assert.match(instruction, /10 March 2026/, 'the local date is stated');
  assert.match(instruction, /Asia\/Singapore/, 'the timezone is stated');
});

test('the injected time reflects the moment, not a cached value', async () => {
  const store = new InMemoryAssistantStore();
  const client = new FakeClient([textTurn('a'), textTurn('b')]);
  let clock = new Date(NOW);
  const service = new AssistantService({
    store,
    registry: createDefaultToolRegistry(),
    client,
    timezone: SINGAPORE,
    now: () => clock,
  });

  await service.processMessage(1, 'first');
  clock = new Date(NOW.getTime() + 3 * 3600_000); // three hours later
  await service.processMessage(1, 'second');

  assert.match(client.systemInstructions[0]!, /09:00/);
  assert.match(client.systemInstructions[1]!, /12:00/);
});

test('tool output is never replayed into the stored conversation', async () => {
  // Live tool data (the time, the reminder list) must not become history: a
  // replayed timestamp is a lie the model will happily repeat.
  const { service, store, client } = makeService([
    callTurn({ id: 'c1', name: 'current_time' }),
    callTurn({ id: 'c2', name: 'save_fact', args: { key: 'k', value: 'v' } }),
    textTurn('Done.'),
  ]);

  const first = await service.processMessage(1, 'remember k');
  assert.equal(first.kind, 'confirmation');
  if (first.kind !== 'confirmation') return;

  await service.approvePendingAction(1, first.confirmation.id);

  // The request that resumed the loop must not contain the earlier time result.
  const resumed = client.calls[2];
  const toolMessages = resumed.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 1, 'only the confirmed call result is present');
  assert.match(toolMessages[0].content, /Saved fact/, 'and it is the write result');

  // Nor is it in the persisted history.
  const history = await store.getRecentMessages(1, 20);
  assert.ok(history.every((message) => !message.content.includes('Local time:')));
});
