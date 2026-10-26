import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTelegramHtml } from '../src/utils/telegram-format.js';

test('prose bullets are formatted without changing literal YAML or diff lines', () => {
  const source = [
    '- First prose item',
    '```yaml',
    'items:',
    '  - one',
    '  - two',
    '```',
    '+ Second prose item',
    '```diff',
    '- removed',
    '+ added',
    '```',
  ].join('\n');
  const html = markdownToTelegramHtml(source);
  assert.ok(html.includes('• First prose item'));
  assert.ok(html.includes('• Second prose item'));
  assert.ok(html.includes('<pre><code class="language-yaml">items:\n  - one\n  - two</code></pre>'));
  assert.ok(html.includes('<pre><code class="language-diff">- removed\n+ added</code></pre>'));
});

test('inline code stays literal while surrounding lists and emphasis are formatted', () => {
  const html = markdownToTelegramHtml('- Run `- value` with **care**.\n```\n- <tag>&value\n```');
  assert.ok(html.includes('• Run <code>- value</code> with <b>care</b>.'));
  assert.ok(html.includes('<pre><code>- &lt;tag&gt;&amp;value</code></pre>'));
});
