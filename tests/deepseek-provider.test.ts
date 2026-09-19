/**
 * DeepSeek provider tests.
 *
 * The network is stubbed: what matters here is the translation between the
 * neutral conversation and OpenAI's chat format, and the parsing of tool calls
 * back out. Those are the parts that break silently if a provider changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Exactly one provider must be configured; pin it before importing src modules.
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'test-key';
delete process.env.GEMINI_API_KEY;
process.env.NODE_ENV = 'production';

const { DeepSeekProvider } = await import('../src/services/deepseek-provider.js');
const { createDefaultToolRegistry } = await import('../src/tools/builtin-tools.js');
type AgentMessage = import('../src/services/ai-client.js').AgentMessage;

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Builds a provider whose HTTP layer is captured instead of sent. */
function makeProvider(response: unknown, status = 200) {
  const requests: CapturedRequest[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });

    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
    } as Response;
  }) as unknown as typeof fetch;

  const provider = new DeepSeekProvider({ fetchImpl, systemInstruction: 'SYSTEM' });
  return { provider, requests };
}

test('toChatMessages maps the neutral conversation onto OpenAI chat format', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'set a reminder' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'create_reminder', args: { text: 'Call mum', when_text: 'in 5 minutes' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'Reminder #1 set.' },
  ];

  const chat = DeepSeekProvider.toChatMessages(messages, 'SYSTEM');

  assert.deepEqual(chat[0], { role: 'system', content: 'SYSTEM' });
  assert.deepEqual(chat[1], { role: 'user', content: 'set a reminder' });

  // Assistant tool calls are stringified arguments, OpenAI style.
  assert.equal(chat[2].role, 'assistant');
  assert.equal(chat[2].content, '');
  assert.deepEqual(chat[2].tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'create_reminder', arguments: JSON.stringify({ text: 'Call mum', when_text: 'in 5 minutes' }) },
    },
  ]);

  // The tool result carries the id and the recovered function name.
  assert.deepEqual(chat[3], {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'create_reminder',
    content: 'Reminder #1 set.',
  });
});

test('tool results whose assistant turn is missing still map without a name', () => {
  const chat = DeepSeekProvider.toChatMessages(
    [{ role: 'tool', toolCallId: 'orphan', content: 'x' }],
    'SYSTEM'
  );
  assert.equal(chat[1].role, 'tool');
  assert.equal(chat[1].tool_call_id, 'orphan');
  assert.equal(chat[1].name, undefined);
});

test('generate sends the model, messages and tool declarations', async () => {
  const { provider, requests } = makeProvider({
    choices: [{ message: { content: 'Sure thing.' } }],
  });

  const turn = await provider.generate(
    [{ role: 'user', content: 'hello' }],
    createDefaultToolRegistry()
  );

  assert.equal(turn.text, 'Sure thing.');
  assert.deepEqual(turn.toolCalls, []);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer test-key');
  assert.equal(requests[0].body.model, 'deepseek-chat');
  assert.equal(requests[0].body.tool_choice, 'auto');

  const tools = requests[0].body.tools as { function: { name: string; parameters: unknown } }[];
  assert.ok(Array.isArray(tools) && tools.length > 0, 'tool declarations were sent');
  assert.ok(tools.some((tool) => tool.function.name === 'create_reminder'));
  // Standard lowercase JSON Schema, which is what the OpenAI format expects.
  const reminderTool = tools.find((tool) => tool.function.name === 'create_reminder')!;
  assert.equal((reminderTool.function.parameters as { type: string }).type, 'object');
});

test('generate parses tool calls out of the response', async () => {
  const { provider } = makeProvider({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'create_reminder', arguments: '{"text":"Call mum","when_text":"in 5 minutes"}' },
            },
          ],
        },
      },
    ],
  });

  const turn = await provider.generate([{ role: 'user', content: 'remind me' }]);

  assert.equal(turn.text, '');
  assert.deepEqual(turn.toolCalls, [
    { id: 'call_abc', name: 'create_reminder', args: { text: 'Call mum', when_text: 'in 5 minutes' } },
  ]);
});

test('a tool call with unparseable arguments degrades to an empty object', async () => {
  const { provider } = makeProvider({
    choices: [
      {
        message: {
          tool_calls: [{ id: 'c1', function: { name: 'save_fact', arguments: '{"key": "unterminated' } }],
        },
      },
    ],
  });

  const turn = await provider.generate([{ role: 'user', content: 'x' }]);

  // Rather than throwing, the registry will report the missing parameter to the
  // model, which can then correct itself.
  assert.deepEqual(turn.toolCalls[0].args, {});
});

test('a tool call with no arguments at all is accepted', async () => {
  const { provider } = makeProvider({
    choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'current_time' } }] } }],
  });

  const turn = await provider.generate([{ role: 'user', content: 'what time is it' }]);
  assert.deepEqual(turn.toolCalls, [{ id: 'c1', name: 'current_time', args: {} }]);
});

test('no tools are sent when the registry is empty', async () => {
  const { provider, requests } = makeProvider({ choices: [{ message: { content: 'hi' } }] });

  await provider.generate([{ role: 'user', content: 'hi' }], { list: () => [], toFunctionDeclarations: () => [] });

  assert.equal(requests[0].body.tools, undefined);
  assert.equal(requests[0].body.tool_choice, undefined);
});

test('an API error surfaces the provider message', async () => {
  const { provider } = makeProvider({ error: { message: 'Insufficient Balance' } }, 402);

  await assert.rejects(
    () => provider.generate([{ role: 'user', content: 'hi' }]),
    /DeepSeek API 402: Insufficient Balance/
  );
});

test('an invalid API key surfaces too', async () => {
  const { provider } = makeProvider({ error: { message: 'Authentication Fails' } }, 401);

  await assert.rejects(
    () => provider.generate([{ role: 'user', content: 'hi' }]),
    /DeepSeek API 401: Authentication Fails/
  );
});

test('a non-JSON response is reported instead of crashing the parser', async () => {
  const { provider } = makeProvider('<html>gateway error</html>', 502);

  await assert.rejects(
    () => provider.generate([{ role: 'user', content: 'hi' }]),
    /DeepSeek API 502/
  );
});

test('a response with no choices is an error, not a silent empty reply', async () => {
  const { provider } = makeProvider({ choices: [] });

  await assert.rejects(
    () => provider.generate([{ role: 'user', content: 'hi' }]),
    /no choices/
  );
});

test('generateText works without tools', async () => {
  const { provider, requests } = makeProvider({ choices: [{ message: { content: 'Answer' } }] });

  const text = await provider.generateText('question');

  assert.equal(text, 'Answer');
  assert.equal(requests[0].body.tools, undefined);
  assert.deepEqual(requests[0].body.messages, [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'question' },
  ]);
});
