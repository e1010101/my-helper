/**
 * Renders the assistant's stored memory for `/memory`.
 *
 * Extracted from the command handler so the staleness display is testable
 * without driving a bot update, since the only way to seed an aged fact in a
 * test would otherwise be a test-only seam in the store interface.
 */
import type { Fact, Reminder } from '../types/assistant.js';
import { escapeHtml } from './telegram-format.js';
import { formatLocal } from '../services/reminder-time.js';
import { describeFactAge, FACT_STALE_AFTER_DAYS } from '../services/token-usage.js';

/** Counts facts old enough that they may no longer be true. */
export function countStaleFacts(facts: Fact[], now: Date = new Date()): number {
  return facts.filter((fact) => describeFactAge(fact.updatedAt, now).stale).length;
}

/**
 * Renders the facts section. Staleness is surfaced rather than acted on: only
 * the user can judge whether a months-old preference still holds, so the age is
 * shown and flagged but nothing is deleted or expired.
 */
export function formatFacts(facts: Fact[], now: Date = new Date()): string {
  if (facts.length === 0) {
    return '(none yet)';
  }

  const lines = facts.map((fact) => {
    const age = describeFactAge(fact.updatedAt, now);
    const tier = fact.tier === 'core' ? ' <i>(core)</i>' : '';
    const ageNote = age.stale ? ` ⚠️ <i>${age.label}</i>` : ` <i>(${age.label})</i>`;
    return `• <b>${escapeHtml(fact.key)}</b>: ${escapeHtml(fact.value)}${tier}${ageNote}`;
  });

  const stale = countStaleFacts(facts, now);
  if (stale > 0) {
    lines.push(
      `⚠️ ${stale} fact${stale === 1 ? '' : 's'} not updated in over ${FACT_STALE_AFTER_DAYS} days — worth confirming still true.`
    );
  }

  return lines.join('\n');
}

/** Renders the reminders section. */
export function formatReminders(reminders: Reminder[], timezone: string): string {
  if (reminders.length === 0) {
    return '(none)';
  }

  return reminders
    .map((reminder) => {
      const when = formatLocal(new Date(reminder.nextRunAt), timezone);
      const cadence = reminder.frequency === 'once' ? '' : ` (${reminder.frequency})`;
      return `• #${reminder.id} ${escapeHtml(reminder.text)} — ${escapeHtml(when)}${cadence}`;
    })
    .join('\n');
}
