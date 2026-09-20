/**
 * Tests for token accounting.
 *
 * The value of these numbers depends entirely on them being trustworthy: if the
 * breakdown silently misattributes tokens, any decision about memory bloat is
 * made on fiction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { breakdownRequest, estimateTokens } from '../src/services/token-usage.js';
import { DeepSeekProvider } from '../src/services/deepseek-provider.js';

const composition = { systemChars: 400, toolsChars: 2000, messagesChars: 600 };

test('breakdown attributes the provider total across components', () => {
  const breakdown = breakdownRequest(composition, 900);

  // The parts must always sum to the reported total, or the numbers contradict
  // each other and the split is useless.
  assert.equal(
    breakdown.system + breakdown.tools + breakdown.messages,
    900,
    'components must sum to the provider-reported prompt tokens'
  );
  assert.equal(breakdown.estimatedPromptTokens, 900);
});

test('the largest component receives the largest share', () => {
  const breakdown = breakdownRequest(composition, 1000);

  assert.ok(breakdown.tools > breakdown.messages, 'tools dominate when they are longest');
  assert.ok(breakdown.messages > breakdown.system, 'messages beat the short system prompt');
});

test('shares are proportional to character length', () => {
  const breakdown = breakdownRequest({ systemChars: 100, toolsChars: 100, messagesChars: 200 }, 400);

  assert.equal(breakdown.system, 100);
  assert.equal(breakdown.tools, 100);
  assert.equal(breakdown.messages, 200);
});

test('without a provider total it falls back to estimation', () => {
  const breakdown = breakdownRequest(composition);

  assert.ok(breakdown.estimatedPromptTokens > 0);
  assert.ok(breakdown.tools > breakdown.messages);
  assert.equal(breakdown.estimatedPromptTokens, estimateTokens('x'.repeat(3000)));
});

test('a zero-token response does not produce NaN', () => {
  const breakdown = breakdownRequest(composition, 0);

  for (const value of [breakdown.system, breakdown.tools, breakdown.messages]) {
    assert.ok(Number.isFinite(value), 'no NaN in the fallback path');
  }
});

test('an empty request reports zeroes rather than dividing by zero', () => {
  const breakdown = breakdownRequest({ systemChars: 0, toolsChars: 0, messagesChars: 0 }, 0);

  assert.equal(breakdown.system, 0);
  assert.equal(breakdown.tools, 0);
  assert.equal(breakdown.messages, 0);
});

test('estimateTokens scales with length', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(380)) === 100, '380 chars is about 100 tokens');
  assert.ok(estimateTokens('a'.repeat(1000)) > estimateTokens('a'.repeat(100)));
});

// --- Provider usage parsing ------------------------------------------------

function providerWith(response: unknown, status = 200) {
  const fetchImpl = (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
    }) as Response) as unknown as typeof fetch;

  return new DeepSeekProvider({ fetchImpl, systemInstruction: 'S' });
}

test('provider usage is mapped onto the neutral shape', async () => {
  const provider = providerWith({
    choices: [{ message: { content: 'hi' } }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
      prompt_cache_hit_tokens: 900,
    },
  });

  const turn = await provider.generate([{ role: 'user', content: 'x' }]);

  assert.deepEqual(turn.usage, {
    promptTokens: 1200,
    completionTokens: 40,
    totalTokens: 1240,
    cachedTokens: 900,
  });
});

test('cached tokens fall back to prompt_tokens_details', async () => {
  const provider = providerWith({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510, prompt_tokens_details: { cached_tokens: 256 } },
  });

  const turn = await provider.generate([{ role: 'user', content: 'x' }]);
  assert.equal(turn.usage?.cachedTokens, 256);
});

test('a response without usage leaves it undefined, not zero', async () => {
  const provider = providerWith({ choices: [{ message: { content: 'hi' } }] });

  const turn = await provider.generate([{ role: 'user', content: 'x' }]);

  // "no data" and "zero tokens" must be distinguishable: reporting 0 would look
  // like a free request and quietly hide that accounting stopped working.
  assert.equal(turn.usage, undefined);
});

test('a malformed usage block is ignored rather than producing NaN', async () => {
  const provider = providerWith({
    choices: [{ message: { content: 'hi' } }],
    usage: { completion_tokens: 5 },
  });

  const turn = await provider.generate([{ role: 'user', content: 'x' }]);
  assert.equal(turn.usage, undefined);
});
