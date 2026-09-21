/**
 * The usage dashboard.
 *
 * A single self-contained page: no framework, no external assets, no client-side
 * fetch. It is rendered server-side from data the store already aggregates, so
 * there is nothing extra to deploy and nothing to keep in sync.
 *
 * Every value interpolated here comes from our own database, but it is escaped
 * anyway — a page that is safe only because of an assumption about its inputs is
 * one refactor away from being unsafe.
 */
import { escapeHtml } from '../utils/telegram-format.js';
import type { DailyTokenUsage, TokenUsageSummary } from '../types/assistant.js';

export interface DashboardData {
  summary: TokenUsageSummary;
  daily: DailyTokenUsage[];
  windowDays: number;
  timezone: string;
  generatedAt: Date;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Inline SVG sparkline of average prompt size.
 *
 * Deliberately hand-rolled: a charting library would be the largest dependency
 * in the project, for one line on one internal page. Returns empty markup when
 * there is nothing meaningful to plot, rather than a flat lie.
 */
function sparkline(daily: DailyTokenUsage[]): string {
  if (daily.length < 2) {
    return '<p class="muted">Not enough days yet to show a trend.</p>';
  }

  const values = daily.map((day) => day.averagePromptTokens);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);

  const width = 640;
  const height = 120;
  const step = width / (values.length - 1);

  const points = values.map((value, index) => {
    const x = index * step;
    // Invert: SVG y grows downward, and a rising prompt size should look rising.
    const y = height - ((value - min) / span) * (height - 20) - 10;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = daily[0].date;
  const last = daily[daily.length - 1].date;

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="Average prompt tokens per day, ${escapeHtml(first)} to ${escapeHtml(last)}">
      <polyline fill="none" stroke="#5b8def" stroke-width="2" points="${points.join(' ')}" />
    </svg>
    <div class="axis">
      <span>${escapeHtml(first)}</span>
      <span>min ${compact(min)} &middot; max ${compact(max)}</span>
      <span>${escapeHtml(last)}</span>
    </div>`;
}

function dailyRows(daily: DailyTokenUsage[]): string {
  if (daily.length === 0) {
    return '<tr><td colspan="7" class="muted">No usage recorded in this window yet.</td></tr>';
  }

  // Newest first: the most recent day is what you came to look at.
  return [...daily]
    .reverse()
    .map((day) => {
      const cacheShare = percent(day.cachedTokens, day.promptTokens);
      return `<tr>
        <td>${escapeHtml(day.date)}</td>
        <td class="num">${day.calls}</td>
        <td class="num">${compact(day.averagePromptTokens)}</td>
        <td class="num">${compact(day.averageSystemTokens)}</td>
        <td class="num">${compact(day.averageToolsTokens)}</td>
        <td class="num">${compact(day.averageMessagesTokens)}</td>
        <td class="num">${cacheShare}%</td>
      </tr>`;
    })
    .join('');
}

export function renderDashboard(data: DashboardData): string {
  const { summary, daily, windowDays, timezone, generatedAt } = data;
  const cacheShare = percent(summary.cachedTokens, summary.promptTokens);

  const trend = daily.length >= 2
    ? daily[daily.length - 1].averagePromptTokens - daily[0].averagePromptTokens
    : 0;
  const trendLabel = daily.length < 2
    ? 'not enough data yet'
    : trend === 0
      ? 'flat over this window'
      : `${trend > 0 ? '+' : ''}${trend} tokens vs the first day`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Assistant usage</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 32px 20px; background: #f6f7f9; color: #1f2328; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; color: #57606a; font-weight: 600; }
  p.muted, td.muted { color: #6e7781; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
  .card { flex: 1 1 150px; background: #fff; border: 1px solid #d0d7de;
          border-radius: 8px; padding: 12px 14px; }
  .card .label { font-size: 12px; color: #57606a; text-transform: uppercase;
                 letter-spacing: .04em; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #fff;
          border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #eaeef2; }
  th { font-size: 12px; color: #57606a; text-transform: uppercase;
       letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  svg { width: 100%; height: 120px; display: block; }
  .axis { display: flex; justify-content: space-between; font-size: 12px;
          color: #6e7781; }
  footer { margin-top: 28px; font-size: 12px; color: #6e7781; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    h2, .card .label, th { color: #8b949e; }
    .card, table { background: #161b22; border-color: #30363d; }
    th, td { border-bottom-color: #21262d; }
    p.muted, td.muted, footer, .axis { color: #8b949e; }
  }
</style>
</head>
<body>
<main>
  <h1>Assistant usage</h1>
  <p class="muted">Last ${windowDays} days &middot; times shown in ${escapeHtml(timezone)}</p>

  <div class="cards">
    <div class="card"><div class="label">Model calls</div><div class="value">${summary.calls}</div></div>
    <div class="card"><div class="label">Total tokens</div><div class="value">${compact(summary.totalTokens)}</div></div>
    <div class="card"><div class="label">Avg prompt</div><div class="value">${compact(summary.averagePromptTokens)}</div></div>
    <div class="card"><div class="label">From cache</div><div class="value">${cacheShare}%</div></div>
  </div>

  <h2>Average prompt size &mdash; ${escapeHtml(trendLabel)}</h2>
  ${sparkline(daily)}

  <h2>Per day</h2>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th class="num">Calls</th>
        <th class="num">Avg prompt</th>
        <th class="num">of which system</th>
        <th class="num">tools</th>
        <th class="num">messages</th>
        <th class="num">Cached</th>
      </tr>
    </thead>
    <tbody>${dailyRows(daily)}</tbody>
  </table>

  <p class="muted" style="margin-top:12px">
    The three component columns are averages per call and always sum to the average
    prompt: they show whether growth comes from memory or from the tool schemas.
  </p>

  <footer>
    Generated ${escapeHtml(generatedAt.toISOString())} &middot;
    ${escapeHtml(plural(summary.calls, 'model call'))} in this window.
    Refresh for the latest.
  </footer>
</main>
</body>
</html>`;
}
