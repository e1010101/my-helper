/**
 * Tests for token accounting.
 *
 * The value of these numbers depends entirely on them being trustworthy: if the
 * breakdown silently misattributes tokens, any decision about memory bloat is
 * made on fiction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  breakdownRequest,
  buildFactsBlock,
  commonPrefix,
  describeFactAge,
  estimateTokens,
  FACT_STALE_AFTER_DAYS,
  MAX_CORE_FACTS,
  MAX_FACT_VALUE_CHARS,
} from '../src/services/token-usage.js';
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

// --- Fact block ------------------------------------------------------------

test('no facts produces no block at all', () => {
  const block = buildFactsBlock([]);

  assert.equal(block.text, '');
  assert.equal(block.included, 0);
});

test('facts are rendered as key: value lines', () => {
  const block = buildFactsBlock([
    { key: 'diet', value: 'vegetarian' },
    { key: 'home_city', value: 'Singapore' },
  ]);

  assert.match(block.text, /diet: vegetarian/);
  assert.match(block.text, /home_city: Singapore/);
  assert.equal(block.included, 2);
});

test('a shared key prefix is stated once rather than repeated', () => {
  // Ten "preference_*" keys would otherwise spend most of the block repeating
  // the word "preference".
  const facts = Array.from({ length: 5 }, (_, i) => ({ key: `preference_${i}`, value: `v${i}` }));
  const block = buildFactsBlock(facts);

  assert.equal(commonPrefix(facts.map((f) => f.key)), 'preference_');
  assert.match(block.text, /prefixed "preference_"/);
  assert.match(block.text, /0: v0/);
  assert.ok(
    block.text.split('preference_').length - 1 <= 1,
    'the prefix should appear only in the explanation, not on every line'
  );
});

test('the number of injected facts is capped', () => {
  const facts = Array.from({ length: MAX_CORE_FACTS + 7 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
  const block = buildFactsBlock(facts);

  assert.equal(block.included, MAX_CORE_FACTS);
  assert.equal(block.omitted, 7);
  // Withheld facts are disclosed, not silently dropped: an assistant that
  // believes it has the whole picture is worse than one that knows it does not.
  assert.match(block.text, /7 more stored facts not shown/);
  assert.match(block.text, /list_facts/);
});

test('an over-long value is truncated and counted', () => {
  const block = buildFactsBlock([{ key: 'essay', value: 'x'.repeat(500) }]);

  assert.equal(block.truncated, 1);
  assert.ok(block.text.length < 500, 'the value was actually shortened');
  assert.ok(block.text.includes('…'));
});

test('a single runaway value cannot crowd out other facts', () => {
  const block = buildFactsBlock([
    { key: 'essay', value: 'x'.repeat(10_000) },
    { key: 'diet', value: 'vegetarian' },
  ]);

  assert.match(block.text, /diet: vegetarian/, 'the short fact still survives');
  assert.ok(
    block.text.length < MAX_FACT_VALUE_CHARS * 3,
    'total size stays bounded by the per-value cap'
  );
});

test('the block size stays within a predictable bound', () => {
  const facts = Array.from({ length: MAX_CORE_FACTS }, (_, i) => ({
    key: `fact_number_${i}`,
    value: 'y'.repeat(MAX_FACT_VALUE_CHARS + 50),
  }));

  const block = buildFactsBlock(facts);
  // Worst case is what makes injection affordable: ~20 x 200 chars is about
  // 1,100 tokens, and it cannot grow beyond that no matter how much is stored.
  assert.ok(block.text.length < 6_000, `block was ${block.text.length} chars`);
});

// --- Fact age / staleness --------------------------------------------------

const NOW = new Date('2026-06-15T12:00:00Z');

/** An ISO timestamp `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

test('a fact written today reads as today', () => {
  const age = describeFactAge(daysAgo(0), NOW);

  assert.equal(age.label, 'today');
  assert.equal(age.stale, false);
});

test('a fact from yesterday is singular', () => {
  assert.equal(describeFactAge(daysAgo(1), NOW).label, 'yesterday');
});

test('recent facts read in days, older ones in months and years', () => {
  assert.equal(describeFactAge(daysAgo(5), NOW).label, '5 days ago');
  assert.equal(describeFactAge(daysAgo(60), NOW).label, '2 months ago');
  assert.equal(describeFactAge(daysAgo(400), NOW).label, '1 years ago');
});

test('staleness begins at the threshold, not before', () => {
  assert.equal(describeFactAge(daysAgo(FACT_STALE_AFTER_DAYS - 1), NOW).stale, false);
  assert.equal(describeFactAge(daysAgo(FACT_STALE_AFTER_DAYS), NOW).stale, true);
  assert.equal(describeFactAge(daysAgo(FACT_STALE_AFTER_DAYS + 100), NOW).stale, true);
});

test('a missing timestamp is unknown age, not stale', () => {
  // Unknown age is not evidence of decay. Flagging it would train the user to
  // ignore the warning, which is worse than saying nothing.
  for (const input of [undefined, '', 'not-a-date']) {
    const age = describeFactAge(input, NOW);
    assert.equal(age.label, 'unknown age');
    assert.equal(age.stale, false);
  }
});

test('a future timestamp reads as today rather than a negative age', () => {
  // Clock skew must not produce "-3 days ago", which reads like a bug.
  const age = describeFactAge(new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), NOW);

  assert.equal(age.label, 'today');
  assert.equal(age.days, 0);
  assert.equal(age.stale, false);
});

test('age is measured against the supplied clock, not the real one', () => {
  // Deterministic: the same input yields different results for different nows.
  const written = daysAgo(100);
  assert.equal(describeFactAge(written, NOW).stale, true);
  assert.equal(describeFactAge(written, new Date(NOW.getTime() + 400 * 86_400_000)).stale, true);
  assert.equal(describeFactAge(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW).label, 'today');
});
