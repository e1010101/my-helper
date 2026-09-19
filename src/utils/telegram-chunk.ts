/**
 * Splits outgoing messages to fit Telegram's limits.
 *
 * Telegram rejects a message whose *visible* text exceeds 4096 characters, so
 * without this a long model answer fails to send at all — and because that send
 * happens inside the assistant handler's try/catch, the user sees a generic
 * "having trouble" error even though the model answered fine.
 *
 * With `parse_mode: 'HTML'` Telegram counts visible characters rather than
 * markup, so the split must respect visible length while never cutting a tag or
 * an entity in half. Formatting open at a boundary is closed at the end of one
 * chunk and reopened in the next, so bold or code spanning the split still
 * renders.
 *
 * Implementation note: the source is walked one visible character at a time,
 * recording a legal cut position after each. Nothing is ever computed by
 * mapping between visible and HTML offsets afterwards, which is what makes
 * "never cut a tag or entity" true by construction.
 */

/** Telegram's documented limit for a single message's visible text. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Headroom below the limit for the tags added when formatting spans a split. */
export const TELEGRAM_CHUNK_LIMIT = 3800;

const TAG_PATTERN = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/;
const ENTITY_PATTERN = /^&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

interface OpenTag {
  name: string;
  opening: string;
}

/** A legal place to cut, and the tag stack in effect there. */
interface BreakPoint {
  /** Offset into the source HTML. */
  html: number;
  /** Visible characters emitted up to here. */
  visible: number;
  /** Tags open at this point. */
  open: OpenTag[];
  /** Paragraph, line, or word boundary — used to prefer nicer cuts. */
  rank: 0 | 1 | 2;
}

interface ChunkEnd {
  /** Whether the whole input was consumed. */
  done: boolean;
  /** Offset past the last emitted visible character. */
  html: number;
  visible: number;
  open: OpenTag[];
  /** Boundary candidates seen within this window, best-last. */
  candidates: BreakPoint[];
  /** Visible characters emitted in this window. */
  emitted: number;
}

function cloneOpen(open: OpenTag[]): OpenTag[] {
  return open.map((entry) => ({ ...entry }));
}

/**
 * Walks `html` from `from`, emitting at most `maxVisible` visible characters,
 * and records every legal cut position along the way.
 */
function scan(html: string, from: { html: number; visible: number; open: OpenTag[] }, maxVisible: number): ChunkEnd {
  const open = cloneOpen(from.open);
  const candidates: BreakPoint[] = [];

  let htmlAt = from.html;
  let visible = from.visible;
  let emitted = 0;

  const record = (rank: BreakPoint['rank']) => {
    candidates.push({ html: htmlAt, visible, open: cloneOpen(open), rank });
  };

  while (htmlAt < html.length && emitted < maxVisible) {
    const rest = html.slice(htmlAt);

    const tag = TAG_PATTERN.exec(rest);
    if (tag) {
      const name = tag[2].toLowerCase();
      if (tag[1] === '/') {
        const at = open.map((entry) => entry.name).lastIndexOf(name);
        if (at !== -1) {
          open.splice(at, 1);
        }
      } else {
        open.push({ name, opening: tag[0] });
      }
      htmlAt += tag[0].length;
      continue;
    }

    const entity = ENTITY_PATTERN.exec(rest);
    const raw = entity ? entity[0] : html[htmlAt];
    htmlAt += raw.length;
    visible += 1;
    emitted += 1;

    // A cut is legal immediately after any complete character.
    if (/\n/.test(raw)) {
      record(0);
    } else if (/[ \t]/.test(raw)) {
      record(1);
    } else {
      record(2);
    }
  }

  return {
    done: htmlAt >= html.length,
    html: htmlAt,
    visible,
    open,
    candidates,
    emitted,
  };
}

/**
 * Picks the best cut from the window: the latest paragraph break, else the
 * latest line break, else the latest word break, else the last character.
 */
function pickBreak(candidates: BreakPoint[]): BreakPoint | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  // Look back only so far, so a chunk never becomes absurdly short.
  const floor = Math.floor(candidates.length * 0.6);

  for (const rank of [0, 1, 2] as const) {
    for (let i = candidates.length - 1; i >= floor; i--) {
      if (candidates[i].rank === rank) {
        return candidates[i];
      }
    }
  }

  return candidates[candidates.length - 1];
}

/**
 * Splits HTML into chunks whose visible length fits the limit.
 *
 * Returns a single-element array when no split is needed, so callers can use it
 * unconditionally.
 */
export function splitTelegramHtml(
  html: string,
  limit: number = TELEGRAM_CHUNK_LIMIT
): string[] {
  if (html.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = { html: 0, visible: 0, open: [] as OpenTag[] };
  // Formatting left open by the previous chunk, reopened at the start of this one.
  let carried: OpenTag[] = [];

  while (cursor.html < html.length) {
    const scanEnd = scan(html, cursor, limit);

    // Whole remainder fits: emit it, reopening any carried formatting.
    if (scanEnd.done) {
      const prefix = carried.map((entry) => entry.opening).join('');
      const text = html.slice(cursor.html).trim();
      if (text.length > 0) {
        chunks.push(`${prefix}${text}`);
      }
      break;
    }

    const cut = pickBreak(scanEnd.candidates);

    // Only cut where a visible character actually ended; anything else would
    // either drop text or cut through a tag.
    const usable = cut && cut.visible > cursor.visible ? cut : undefined;

    if (!usable) {
      // No legal break in this window. Emit what was scanned, closing whatever
      // it left open, so the loop always advances.
      const prefix = carried.map((entry) => entry.opening).join('');
      const closing = [...scanEnd.open].reverse().map((entry) => `</${entry.name}>`).join('');
      const text = html.slice(cursor.html, scanEnd.html).trim();
      if (text.length > 0) {
        chunks.push(`${prefix}${text}${closing}`);
      }
      cursor = { html: scanEnd.html, visible: scanEnd.visible, open: scanEnd.open };
      carried = scanEnd.open;
      continue;
    }

    const prefix = carried.map((entry) => entry.opening).join('');
    const closing = [...usable.open].reverse().map((entry) => `</${entry.name}>`).join('');
    const text = html.slice(cursor.html, usable.html).trim();

    if (usable.html <= cursor.html) {
      // Defensive: never loop without advancing.
      break;
    }

    if (text.length > 0) {
      chunks.push(`${prefix}${text}${closing}`);
    }

    cursor = { html: usable.html, visible: usable.visible, open: usable.open };
    carried = usable.open;
  }

  return chunks;
}
