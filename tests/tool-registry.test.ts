import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry, ToolArgumentError, validateArguments, type ToolDefinition } from '../src/tools/registry.js';
import { createDefaultToolRegistry } from '../src/tools/builtin-tools.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo a message',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      times: { type: 'integer', minimum: 1, maximum: 5 },
      mode: { type: 'string', enum: ['plain', 'loud'] },
    },
    required: ['message'],
  },
  async execute(args) {
    return String(args.message);
  },
};

test('registry rejects duplicate tool names', () => {
  const registry = new ToolRegistry([echoTool]);
  assert.throws(() => registry.register(echoTool), /already registered/);
});

test('registry.resolve reports unknown tools without throwing', () => {
  const registry = new ToolRegistry([echoTool]);
  const result = registry.resolve('nope', {});
  assert.equal(result.call, undefined);
  assert.match(result.error ?? '', /Unknown tool/);
});

test('validateArguments enforces required parameters', () => {
  assert.throws(() => validateArguments(echoTool, {}), ToolArgumentError);
  assert.throws(() => validateArguments(echoTool, {}), /Missing required parameter "message"/);
});

test('validateArguments rejects unexpected parameters', () => {
  assert.throws(
    () => validateArguments(echoTool, { message: 'hi', bogus: 1 }),
    /Unexpected parameter "bogus"/
  );
});

test('validateArguments coerces numerics and enforces bounds', () => {
  assert.deepEqual(validateArguments(echoTool, { message: 'hi', times: '3' }), {
    message: 'hi',
    times: 3,
  });

  assert.throws(() => validateArguments(echoTool, { message: 'hi', times: 9 }), /at most 5/);
  assert.throws(() => validateArguments(echoTool, { message: 'hi', times: 0 }), /at least 1/);
  assert.throws(() => validateArguments(echoTool, { message: 'hi', times: 1.5 }), /whole number/);
});

test('validateArguments rejects wrong types and invalid enum values', () => {
  assert.throws(() => validateArguments(echoTool, { message: 42 }), /must be a string/);
  assert.throws(
    () => validateArguments(echoTool, { message: 'hi', mode: 'whisper' }),
    /must be one of: plain, loud/
  );
});

test('default registry exposes both read and write tools', () => {
  const registry = createDefaultToolRegistry();
  const reads = registry.listByKind('read').map((tool) => tool.name);
  const writes = registry.listByKind('write').map((tool) => tool.name);

  assert.ok(reads.includes('current_time'));
  assert.ok(reads.includes('list_reminders'));
  assert.ok(writes.includes('create_reminder'));
  assert.ok(writes.includes('save_fact'));
});

test('function declarations are shaped for the model', () => {
  const registry = createDefaultToolRegistry();
  const declarations = registry.toFunctionDeclarations();

  assert.ok(declarations.length > 0);
  for (const declaration of declarations) {
    assert.equal(typeof declaration.name, 'string');
    assert.ok(declaration.description.length > 0);
    assert.equal(declaration.parametersJsonSchema.type, 'object');
  }
});
