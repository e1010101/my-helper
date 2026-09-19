/**
 * Telegram parse-mode helpers.
 *
 * Two separate problems are solved here:
 *
 * 1. `escapeHtml` — user-supplied text (task names, prompt titles, descriptions)
 *    is interpolated into bot messages. With a parse_mode enabled, a stray `*`,
 *    `_`, `<` or `&` makes Telegram reject the whole message with a 400
 *    "can't parse entities" error, so the text must be escaped before it is
 *    embedded.
 *
 * 2. `markdownToTelegramHtml` — Gemini answers in standard Markdown, which is
 *    not the same dialect Telegram understands (Telegram's legacy Markdown is
 *    not CommonMark: it has no `**bold**`, no headings and no fenced code
 *    blocks). Converting to HTML is the reliable path.
 */

/** Private-use markers used to shield extracted code from the formatters. */
const PLACEHOLDER_PREFIX = '\uE000';
const PLACEHOLDER_SUFFIX = '\uE001';

/** Escapes text for use inside a Telegram HTML-parsed message. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converts standard Markdown (as produced by LLMs) into the HTML subset
 * Telegram supports: <b>, <i>, <s>, <code>, <pre>, <a href>.
 *
 * Anything unrecognised is emitted as escaped plain text, so the result is
 * always safe to send with `parse_mode: 'HTML'`.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // Placeholders are built from private-use characters (never present in real
  // message text) so protected code survives the escaping step below.
  const placeholder = (kind: string, index: number) => `${PLACEHOLDER_PREFIX}${kind}${index}${PLACEHOLDER_SUFFIX}`;

  // Fenced code blocks must be extracted first: their contents are literal and
  // must not go through the inline formatters below.
  let text = markdown.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
    const lang = language.trim();
    const body = code.replace(/\n$/, '');
    const openTag = lang ? `<pre><code class="language-${escapeHtml(lang)}">` : '<pre><code>';
    codeBlocks.push(`${openTag}${escapeHtml(body)}</code></pre>`);
    return placeholder('C', codeBlocks.length - 1);
  });

  // Inline code is likewise protected before bold/italic processing.
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder('I', inlineCode.length - 1);
  });

  // Escape everything that remains, then re-introduce the supported markup.
  text = escapeHtml(text);

  // Links [label](url) — only http(s) targets are linkified.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    return `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`;
  });

  // Bold: **text** and __text__
  text = text.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^\n]+?)__/g, '<b>$1</b>');

  // Strikethrough: ~~text~~
  text = text.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');

  // Italic: *text* and _text_. The opening delimiter must be followed by a
  // non-space and the closing one preceded by a non-space, so arithmetic
  // ("5 * 3 * 2") is not mistaken for emphasis, and `_` additionally needs
  // word boundaries so snake_case identifiers survive.
  text = text.replace(/(^|[\s(])\*(\S(?:[^*\n]*?\S)?)\*(?=[\s.,!?):;]|$)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[\s(])_(\S(?:[^_\n]*?\S)?)_(?=[\s.,!?):;]|$)/g, '$1<i>$2</i>');

  // Headings and blockquotes have no Telegram equivalent; keep the text.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');

  // Restore code, then normalise list bullets.
  text = text.replace(/[\uE000]([CI])(\d+)[\uE001]/g, (_match, kind: string, index: string) => {
    const restored = kind === 'I' ? inlineCode[Number(index)] : codeBlocks[Number(index)];
    return restored ?? '';
  });
  text = text.replace(/^(\s*)[-+][ \t]+/gm, '$1• ');

  return text;
}
