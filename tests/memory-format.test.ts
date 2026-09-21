/**
 * Tests for the /memory rendering.
 *
 * The staleness display is the reason this is extracted at all: facts never
 * expire, so surfacing age is the only thing standing between a stored
 * preference and one that quietly stopped being true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countStaleFacts, formatFacts, formatReminders, formatUsage } from '../src/utils/memory-format.js';
import { FACT_STALE_AFTER_DAYS } from '../src/services/token-usage.js';
import type { Fact, Reminder, TokenUsageSummary } from '../src/types/assistant.js';

const NOW = new Date('2026-06-15T12:00:00Z');

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    key: 'diet',
    value: 'vegetarian',
    updatedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
    tier: 'core',
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

test('no facts says so plainly', () => {
  assert.equal(formatFacts([], NOW), '(none yet)');
});

test('a fact is rendered with its key, value and age', () => {
  const rendered = formatFacts([fact()], NOW);

  assert.match(rendered, /<b>diet<\/b>: vegetarian/);
  assert.match(rendered, /2 days ago/);
});

test('core facts are marked, reference facts are not', () => {
  const rendered = formatFacts(
    [fact({ key: 'diet', tier: 'core' }), fact({ key: 'wifi', value: 'x', tier: 'reference' })],
    NOW
  );

  assert.match(rendered, /diet<\/b>: vegetarian <i>\(core\)<\/i>/);
  assert.doesNotMatch(rendered, /wifi<\/b>: x <i>\(core\)<\/i>/);
});

test('a stale fact is flagged and summarised', () => {
  const rendered = formatFacts([fact({ updatedAt: daysAgo(FACT_STALE_AFTER_DAYS + 5) })], NOW);

  assert.match(rendered, /⚠️/);
  assert.match(rendered, /not updated in over \d+ days/);
  assert.match(rendered, /1 fact not updated/, 'the summary is singular for one');
});

test('fresh facts are not flagged', () => {
  const rendered = formatFacts([fact({ updatedAt: daysAgo(1) })], NOW);

  assert.doesNotMatch(rendered, /⚠️/);
  assert.doesNotMatch(rendered, /not updated in over/);
  assert.equal(countStaleFacts([fact({ updatedAt: daysAgo(1) })], NOW), 0);
});

test('the stale summary counts only the stale facts', () => {
  const facts = [
    fact({ key: 'fresh', updatedAt: daysAgo(5) }),
    fact({ key: 'old_a', updatedAt: daysAgo(200) }),
    fact({ key: 'old_b', updatedAt: daysAgo(400) }),
  ];

  assert.equal(countStaleFacts(facts, NOW), 2);
  const rendered = formatFacts(facts, NOW);
  assert.match(rendered, /2 facts not updated/);
});

test('user-supplied text is escaped so a value cannot break the message', () => {
  // Values are arbitrary strings from the model, and this is sent with
  // parse_mode HTML: an unescaped angle bracket would reject the whole message.
  const rendered = formatFacts([fact({ key: 'note', value: '<b>bold</b> & "quoted"' })], NOW);

  assert.match(rendered, /&lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(rendered, /<b>bold<\/b>/);
});

test('a fact with no usable timestamp is shown without a stale warning', () => {
  const rendered = formatFacts([fact({ updatedAt: undefined as unknown as string })], NOW);

  assert.match(rendered, /unknown age/);
  assert.doesNotMatch(rendered, /⚠️/);
});

test('reminders render with their next fire time', () => {
  const reminders: Reminder[] = [
    {
      id: 3,
      userId: 1,
      text: 'Take the bins out',
      nextRunAt: new Date('2026-06-16T01:00:00Z').toISOString(),
      frequency: 'weekly',
      timeOfDay: '09:00',
      dayOfWeek: 1,
      dayOfMonth: null,
      active: true,
      lastSentAt: null,
      createdAt: NOW.toISOString(),
    },
  ];

  const rendered = formatReminders(reminders, 'Asia/Singapore');

  assert.match(rendered, /#3 Take the bins out/);
  assert.match(rendered, /\(weekly\)/);
});

test('no reminders says so plainly', () => {
  assert.equal(formatReminders([], 'Asia/Singapore'), '(none)');
});

test('a one-off reminder omits the cadence suffix', () => {
  const reminders: Reminder[] = [
    {
      id: 1,
      userId: 1,
      text: 'Ping',
      nextRunAt: NOW.toISOString(),
      frequency: 'once',
      timeOfDay: null,
      dayOfWeek: null,
      dayOfMonth: null,
      active: true,
      lastSentAt: null,
      createdAt: NOW.toISOString(),
    },
  ];

  assert.doesNotMatch(formatReminders(reminders, 'Asia/Singapore'), /\(once\)/);
});

// --- Token usage summary ---------------------------------------------------

function summary(overrides: Partial<TokenUsageSummary> = {}): TokenUsageSummary {
  return {
    calls: 10,
    promptTokens: 10_000,
    completionTokens: 1_000,
    totalTokens: 11_000,
    cachedTokens: 4_000,
    averagePromptTokens: 1_000,
    firstRecordedAt: NOW.toISOString(),
    lastRecordedAt: NOW.toISOString(),
    ...overrides,
  };
}

test('an empty window says so rather than showing zeroes', () => {
  const text = formatUsage(summary({ calls: 0, promptTokens: 0, totalTokens: 0, averagePromptTokens: 0 }), 30);

  assert.match(text, /no calls recorded/);
  assert.match(text, /30 days/);
  assert.doesNotMatch(text, /\b0 tokens\b/);
});

test('the summary reports calls, totals and the average prompt size', () => {
  const text = formatUsage(summary(), 30);

  assert.match(text, /10 model call/);
  assert.match(text, /11,000 tokens total/);
  // The average is the number that reveals creeping prompt size; a total alone
  // cannot distinguish "used more" from "asks got longer".
  assert.match(text, /average prompt: 1,000 tokens/);
});

test('the cache share is reported as a percentage', () => {
  assert.match(formatUsage(summary(), 30), /40% of prompt tokens served from cache/);
});

test('a zero-token window does not divide by zero for the cache share', () => {
  const text = formatUsage(summary({ promptTokens: 0, cachedTokens: 0, calls: 1 }), 30);

  assert.match(text, /0% of prompt tokens/);
  assert.doesNotMatch(text, /NaN/);
});

test('cache share is computed against prompt tokens, not the grand total', () => {
  // Using the total would understate the share, since completion tokens can
  // never be cached.
  const text = formatUsage(summary({ promptTokens: 1_000, cachedTokens: 1_000, totalTokens: 5_000 }), 30);

  assert.match(text, /100% of prompt tokens/);
});
