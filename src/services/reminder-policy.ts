import type { ReminderPreferences } from './reminder-action-store.js';
import { getLocalParts, instantFromWallClock } from './reminder-time.js';

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Shared validation for settings entered through Telegram or a store adapter. */
export function validateReminderPreferences(preferences: ReminderPreferences): void {
  if (!Number.isSafeInteger(preferences.userId) || preferences.userId <= 0) throw new Error('Invalid reminder owner.');
  if (typeof preferences.followUpsEnabled !== 'boolean') throw new Error('Follow-ups must be on or off.');
  const { quietHoursStart: start, quietHoursEnd: end } = preferences;
  if (start === null && end === null) return;
  if (typeof start !== 'string' || typeof end !== 'string'
    || !CLOCK_TIME.test(start) || !CLOCK_TIME.test(end)) {
    throw new Error('Use two times in HH:MM format, such as 22:00 08:00, or turn quiet hours off.');
  }
  if (start === end) throw new Error('Quiet hours must have different start and end times.');
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

/** Quiet intervals include the start and exclude the end, in the configured timezone. */
export function quietHoursEnd(now: Date, preferences: ReminderPreferences, timezone: string): Date | null {
  validateReminderPreferences(preferences);
  if (preferences.quietHoursStart === null || preferences.quietHoursEnd === null) return null;
  const start = minuteOfDay(preferences.quietHoursStart);
  const end = minuteOfDay(preferences.quietHoursEnd);
  const isQuiet = (instant: Date) => {
    const parts = getLocalParts(instant, timezone);
    const minute = parts.hour * 60 + parts.minute;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  };
  if (!isQuiet(now)) return null;

  // Walk actual minute boundaries, rather than adding 24 hours or choosing the
  // first instance of a repeated wall time. This handles both DST folds and
  // gaps: if 02:30 does not exist, an interval ending then ends at 03:00.
  const firstMinute = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < 3 * 24 * 60; offset++) {
    const candidate = new Date(firstMinute + offset * 60_000);
    if (!isQuiet(candidate)) return candidate;
  }
  throw new Error('Could not resolve the end of quiet hours in this timezone.');
}

function tomorrowAt(now: Date, timezone: string, hour: number, minute: number): Date {
  const local = getLocalParts(now, timezone);
  const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return instantFromWallClock(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(), hour, minute, timezone);
}

/** First instant of the following local day, for resetting automatic follow-up budgets. */
export function nextLocalDay(now: Date, timezone: string): Date {
  return tomorrowAt(now, timezone, 0, 0);
}

/** Explicit short snoozes use elapsed time; Tomorrow means 09:00 in the user's timezone. */
export function snoozeUntil(now: Date, kind: '10m' | '1h' | 'tomorrow', timezone: string): Date {
  if (kind === '10m') return new Date(now.getTime() + 10 * 60_000);
  if (kind === '1h') return new Date(now.getTime() + 60 * 60_000);
  if (kind === 'tomorrow') return tomorrowAt(now, timezone, 9, 0);
  throw new Error('Unknown snooze duration.');
}
