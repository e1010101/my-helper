/**
 * Token accounting for the assistant loop.
 *
 * The provider reports the *actual* token counts, which is the ground truth for
 * cost. It does not report how those tokens divide between the fixed overhead
 * (system prompt and tool definitions) and the conversation. That split is what
 * tells you whether memory is bloating requests or whether the tool schemas are
 * simply expensive, so it is estimated here by character share.
 *
 * The estimate is deliberately crude: it exists to answer "which component
 * dominates", not to predict billing. Applying one ratio to every component
 * means the ratios between them are meaningful even though the absolute numbers
 * are approximate.
 */
import type { DailyTokenUsage } from '../types/assistant.js';

/** Rough characters-per-token. English prose sits near 4; JSON sits nearer 3. */
const CHARS_PER_TOKEN = 3.8;

/**
 * Hard ceilings on injected facts.
 *
 * These are what keep prompt size predictable. Without them, "inject the core
 * facts" is an unbounded cost; with them the worst case is knowable:
 * 20 x 200 characters is roughly 1,050 tokens.
 *
 * A value cap rather than a total cap, because a single runaway value would
 * otherwise crowd out every other fact.
 */
export const MAX_CORE_FACTS = 20;
export const MAX_FACT_VALUE_CHARS = 200;

/** Longest common prefix shared by every string, used to compress repetition. */
export function commonPrefix(strings: string[]): string {
  if (strings.length === 0) {
    return '';
  }

  let prefix = strings[0];
  for (const value of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) {
      i += 1;
    }
    prefix = prefix.slice(0, i);
    if (prefix === '') {
      break;
    }
  }
  return prefix;
}

export interface FactsBlock {
  /** Ready to append to the system prompt; empty when there is nothing to say. */
  text: string;
  /** Facts actually included. */
  included: number;
  /** Core facts omitted because of the caps. */
  omitted: number;
  /** Values shortened because of MAX_FACT_VALUE_CHARS. */
  truncated: number;
}

/**
 * Renders the core facts for injection into the system prompt.
 *
 * Reports what it withheld rather than silently trimming: an assistant that
 * believes it knows everything about you, while half the facts were dropped, is
 * worse than one that knows it is working from a partial picture.
 */
export function buildFactsBlock(
  facts: { key: string; value: string }[],
  maxFacts: number = MAX_CORE_FACTS,
  maxValueChars: number = MAX_FACT_VALUE_CHARS
): FactsBlock {
  if (facts.length === 0) {
    return { text: '', included: 0, omitted: 0, truncated: 0 };
  }

  // One value per key is guaranteed by the schema, so compression here is safe
  // and keeps a verbose key from dominating the block.
  const prefix = commonPrefix(facts.map((fact) => fact.key));
  const omitted = Math.max(0, facts.length - maxFacts);
  const kept = facts.slice(0, maxFacts);

  let truncated = 0;
  const lines = kept.map((fact) => {
    let value = fact.value;
    if (value.length > maxValueChars) {
      value = `${value.slice(0, maxValueChars - 1)}…`;
      truncated += 1;
    }
    const label = prefix && fact.key.length > prefix.length ? fact.key.slice(prefix.length) : fact.key;
    return `${label}: ${value}`;
  });

  const header = prefix ? `What you know about the user (keys below prefixed "${prefix}"):` : 'What you know about the user:';
  const footer = omitted > 0
    ? `\n(${omitted} more stored fact${omitted === 1 ? '' : 's'} not shown — call list_facts to see everything.)`
    : '';

  return {
    text: `${header}\n${lines.join('\n')}${footer}`,
    included: kept.length,
    omitted,
    truncated,
  };
}

export interface RequestComposition {
  /** System prompt, including the injected current time. */
  systemChars: number;
  /** Serialised tool declarations — usually the largest fixed cost. */
  toolsChars: number;
  /** Conversation history plus the new user message. */
  messagesChars: number;
}

export interface TokenBreakdown {
  system: number;
  tools: number;
  messages: number;
  /** Sum of the three, which should approximate the provider's prompt_tokens. */
  estimatedPromptTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimated tokens for a raw character count. */
function estimateFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A token_usage row, in the shape both stores can produce. */
export interface UsageRow {
  createdAt: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
}

/** Local calendar date for an instant, as "YYYY-MM-DD". */
export function localDateKey(date: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD, which sorts and groups correctly as a string.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Buckets usage rows into per-day aggregates, oldest day first.
 *
 * Kept here rather than in either store so the in-memory and Postgres paths
 * cannot disagree about what a "day" is — bucketing by UTC date would put the
 * user's evening in the wrong day for most timezones.
 */
export function groupUsageByDay(rows: UsageRow[], timezone: string): DailyTokenUsage[] {
  const buckets = new Map<string, UsageRow[]>();

  for (const row of rows) {
    const parsed = new Date(row.createdAt);
    if (Number.isNaN(parsed.getTime())) {
      continue;
    }
    const key = localDateKey(parsed, timezone);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => {
      const sum = (pick: (row: UsageRow) => number) =>
        dayRows.reduce((total, row) => total + (pick(row) ?? 0), 0);

      const calls = dayRows.length;
      const mean = (pick: (row: UsageRow) => number) => Math.round(sum(pick) / calls);

      return {
        date,
        calls,
        promptTokens: sum((row) => row.promptTokens),
        completionTokens: sum((row) => row.completionTokens),
        totalTokens: sum((row) => row.totalTokens),
        cachedTokens: sum((row) => row.cachedTokens),
        averagePromptTokens: mean((row) => row.promptTokens),
        averageSystemTokens: mean((row) => row.systemTokens),
        averageToolsTokens: mean((row) => row.toolsTokens),
        averageMessagesTokens: mean((row) => row.messagesTokens),
      };
    });
}

/**
 * Facts older than this are flagged when listed.
 *
 * Facts never expire, so a preference recorded months ago may simply no longer
 * be true. Rather than build expiry machinery, the age is surfaced so the
 * staleness is visible to the person who can judge it.
 */
export const FACT_STALE_AFTER_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface FactAge {
  /** Short human summary, e.g. "3 days ago". */
  label: string;
  /** Whole days since the fact was written. */
  days: number;
  /** True once the fact is old enough that it may no longer hold. */
  stale: boolean;
}

/**
 * Describes how long ago a fact was written.
 *
 * A fact with no usable timestamp reports `days: 0` and is not treated as
 * stale: unknown age is not evidence of decay, and flagging it would train the
 * user to ignore the warning.
 */
export function describeFactAge(updatedAt: string | undefined, now: Date = new Date()): FactAge {
  if (!updatedAt) {
    return { label: 'unknown age', days: 0, stale: false };
  }

  const then = new Date(updatedAt);
  if (Number.isNaN(then.getTime())) {
    return { label: 'unknown age', days: 0, stale: false };
  }

  const days = Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY);

  // Clock skew or a future timestamp reads as "today" rather than a negative
  // age, which would look like a bug in the output.
  if (days <= 0) {
    return { label: 'today', days: 0, stale: false };
  }

  const label =
    days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : days < 365 ? `${Math.floor(days / 30)} months ago` : `${Math.floor(days / 365)} years ago`;

  return { label, days, stale: days >= FACT_STALE_AFTER_DAYS };
}

/**
 * Splits the provider's prompt token count across components in proportion to
 * their character length, so the parts always sum to the reported total.
 *
 * Scaling to the real total rather than reporting raw estimates keeps the
 * numbers consistent: an estimate of 1,200 against an actual of 900 would
 * otherwise look like a bug.
 */
export function breakdownRequest(
  composition: RequestComposition,
  actualPromptTokens?: number
): TokenBreakdown {
  const { systemChars, toolsChars, messagesChars } = composition;
  const totalChars = systemChars + toolsChars + messagesChars;

  const share = (chars: number) => (totalChars === 0 ? 0 : chars / totalChars);

  if (!actualPromptTokens || actualPromptTokens <= 0) {
    return {
      system: estimateFromChars(systemChars),
      tools: estimateFromChars(toolsChars),
      messages: estimateFromChars(messagesChars),
      estimatedPromptTokens: estimateFromChars(totalChars),
    };
  }

  return {
    system: Math.round(actualPromptTokens * share(systemChars)),
    tools: Math.round(actualPromptTokens * share(toolsChars)),
    messages: Math.round(actualPromptTokens * share(messagesChars)),
    estimatedPromptTokens: actualPromptTokens,
  };
}
