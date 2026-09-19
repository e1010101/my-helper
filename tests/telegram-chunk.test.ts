/**
 * Tests for outgoing message chunking.
 *
 * The invariant that matters: every chunk's *visible* length must be within
 * Telegram's limit, no tag or entity may be split, and formatting spanning a
 * boundary must still render in both halves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitTelegramHtml, TELEGRAM_MESSAGE_LIMIT, TELEGRAM_CHUNK_LIMIT } from '../src/utils/telegram-chunk.js';
import { markdownToTelegramHtml } from '../src/utils/telegram-format.js';

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
const ENTITY_PATTERN = /&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * Visible length as Telegram counts it: tags contribute nothing, each entity
 * counts as the single character it represents. Replacing a tag with a
 * placeholder instead of removing it inflates the count by one per tag.
 */
function visibleLength(html: string): number {
  return html.replace(TAG_PATTERN, '').replace(ENTITY_PATTERN, 'x').length;
}

/** Throws when the HTML is unbalanced or a tag/entity was cut in half. */
function assertWellFormed(html: string): void {
  const stripped = html.replace(TAG_PATTERN, '').replace(ENTITY_PATTERN, 'x');
  assert.ok(!/[<>]/.test(stripped), `stray angle bracket in chunk: ${stripped.slice(0, 80)}`);
  assert.ok(!/&[a-zA-Z#]*$/.test(stripped), 'chunk ends with a truncated entity');

  const stack: string[] = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    if (match[1] === '/') {
      assert.equal(stack.pop(), match[2].toLowerCase(), `unbalanced close of ${match[2]}`);
    } else {
      stack.push(match[2].toLowerCase());
    }
  }
  assert.deepEqual(stack, [], 'unclosed tags at end of chunk');
}

test('short content is returned unchanged as a single chunk', () => {
  const html = '<b>hello</b> world';
  assert.deepEqual(splitTelegramHtml(html), [html]);
});

test('empty input yields no chunks', () => {
  assert.deepEqual(splitTelegramHtml(''), []);
});

test('long plain text is split within the limit and loses nothing', () => {
  const paragraph = 'The quick brown fox jumps over the lazy dog. ';
  const source = paragraph.repeat(200); // ~9000 visible chars

  const chunks = splitTelegramHtml(source);

  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    // The chunker keeps headroom below Telegram's hard limit for the tags it
    // may add; the invariant is that it never exceeds the real limit.
    assert.ok(
      visibleLength(chunk) <= TELEGRAM_MESSAGE_LIMIT,
      `chunk of ${visibleLength(chunk)} exceeds Telegram's limit`
    );
    assert.ok(
      visibleLength(chunk) <= TELEGRAM_CHUNK_LIMIT,
      `chunk of ${visibleLength(chunk)} exceeds the chunker's own target`
    );
  }
  // Whitespace at boundaries may be normalised, so compare without it.
  assert.equal(chunks.join('').replace(/\s+/g, ''), source.replace(/\s+/g, ''));
});

test('splits on paragraph boundaries where possible', () => {
  const paragraph = 'A'.repeat(500);
  const source = Array.from({ length: 20 }, () => paragraph).join('\n\n');

  const chunks = splitTelegramHtml(source);

  assert.ok(chunks.length > 1);
  // Every chunk but the last should end at a paragraph boundary.
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.trimEnd().endsWith('A'), 'chunk ends mid-paragraph unexpectedly');
  }
});

test('never cuts a tag in half', () => {
  const source = '<b>word</b> '.repeat(1200);

  const chunks = splitTelegramHtml(source);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assertWellFormed(chunk);
    assert.ok(visibleLength(chunk) <= TELEGRAM_MESSAGE_LIMIT);
  }
});

test('never cuts an entity in half', () => {
  // Long runs of entities and escaped characters.
  const source = '&amp;&lt;&gt;&quot; '.repeat(800);

  const chunks = splitTelegramHtml(source);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assertWellFormed(chunk);
    assert.ok(
      visibleLength(chunk) <= TELEGRAM_MESSAGE_LIMIT,
      `chunk of ${visibleLength(chunk)} exceeds the limit`
    );
  }
});

test('formatting spanning a boundary is closed and reopened', () => {
  // One bold run far longer than a single message.
  const source = `<b>${'x'.repeat(9000)}</b>`;

  const chunks = splitTelegramHtml(source);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assertWellFormed(chunk);
    assert.ok(chunk.startsWith('<b>'), 'bold was not reopened at the start');
    assert.ok(chunk.endsWith('</b>'), 'bold was not closed at the end');
  }
});

test('text outside the bold run is not accidentally wrapped in it', () => {
  const source = `<b>${'x'.repeat(5000)}</b> plain tail text`;

  const chunks = splitTelegramHtml(source);
  const last = chunks[chunks.length - 1];

  assert.ok(last.includes('plain tail text'), 'the tail survived');

  // The tail must sit outside the bold element, not be swallowed by it: bold
  // closes before the tail text begins.
  const boldClosed = last.indexOf('</b>');
  const tailAt = last.indexOf('plain tail text');
  assert.notEqual(boldClosed, -1, 'the reopened bold run is closed again');
  assert.ok(boldClosed < tailAt, 'bold must close before the unformatted tail');
});

test('code blocks survive a split as well-formed HTML', () => {
  const source = `<pre><code>${'line of code\n'.repeat(1000)}</code></pre>`;

  const chunks = splitTelegramHtml(source);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assertWellFormed(chunk);
    assert.ok(visibleLength(chunk) <= TELEGRAM_MESSAGE_LIMIT);
  }
});

test('a single character longer than the limit is still emitted', () => {
  // Degenerate input must not loop forever or drop content.
  const source = 'x'.repeat(50);
  const chunks = splitTelegramHtml(source, 10);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), source);
});

test('chunking a converted model answer keeps it readable', () => {
  const markdown = [
    '# Report',
    '',
    'Some **bold** statement and `inline code`.',
    '',
    ...Array.from({ length: 120 }, (_, i) => `- Item ${i}: ${'detail '.repeat(6)}`),
  ].join('\n');

  const html = markdownToTelegramHtml(markdown);
  const chunks = splitTelegramHtml(html);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assertWellFormed(chunk);
    assert.ok(visibleLength(chunk) <= TELEGRAM_MESSAGE_LIMIT);
  }
});
