/**
 * Reminder time maths.
 *
 * Everything here works in the user's timezone: reminders are stored as an
 * absolute UTC instant (`next_run_at`) but are *described* by wall-clock rules
 * (daily at 09:00, weekly on Monday), so that "every Monday at 9am" stays 9am
 * across daylight-saving changes.
 *
 * The functions are pure and take an explicit `now`, which keeps them testable
 * without mocking the system clock.
 */

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday */
  dayOfWeek: number;
}

export interface WallClockRule {
  /** "HH:MM" in the target timezone. */
  timeOfDay: string;
  /** Restrict to a weekday (weekly schedules only). */
  dayOfWeek?: number | null;
  /** Restrict to a day of month (monthly schedules only). */
  dayOfMonth?: number | null;
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    PARTS_FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

/** Breaks an instant down into the user's local wall-clock fields. */
export function getLocalParts(date: Date, timezone: string): LocalDateParts {
  const formatted = partsFormatter(timezone).formatToParts(date);

  const lookup: Record<string, number> = {};
  for (const part of formatted) {
    if (part.type !== 'literal') {
      lookup[part.type] = Number.parseInt(part.value, 10);
    }
  }

  // en-CA renders midnight as hour 24 in some runtimes; normalise it.
  const hour = lookup.hour === 24 ? 0 : lookup.hour;

  // Day of week is derived from a UTC date built out of the *local* Y/M/D, so
  // it is the weekday the user is actually experiencing.
  const asUtc = new Date(Date.UTC(lookup.year, lookup.month - 1, lookup.day));

  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour,
    minute: lookup.minute,
    dayOfWeek: asUtc.getUTCDay(),
  };
}

/** Formats the local wall-clock time as "YYYY-MM-DDTHH:MM". */
export function localKey(date: Date, timezone: string): string {
  const parts = getLocalParts(date, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Minutes the given timezone is offset from UTC at that instant. */
function offsetMinutes(date: Date, timezone: string): number {
  const parts = getLocalParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  );
  return (asUtc - date.getTime()) / 60000;
}

/**
 * Converts a wall-clock time in `timezone` to a UTC instant.
 * DST gaps resolve forward, which is the behaviour users expect from an alarm.
 */
export function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = guess - offsetMinutes(new Date(guess), timezone) * 60000;
  // One correction pass handles DST boundaries.
  candidate = guess - offsetMinutes(new Date(candidate), timezone) * 60000;
  return new Date(candidate);
}

/** Parses "HH:MM", returning null when malformed. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

/** Formats a time-of-day pair as "HH:MM". */
export function formatTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Finds the first UTC instant after `after` whose local wall clock matches the
 * rule. Returns null if nothing matches within five years (e.g. a malformed
 * monthly rule).
 */
export function nextOccurrence(rule: WallClockRule, after: Date, timezone: string): Date | null {
  const time = parseTimeOfDay(rule.timeOfDay);
  if (!time) {
    return null;
  }

  const MAX_DAYS = 366 * 5;
  const cursor = new Date(after.getTime());
  const startParts = getLocalParts(cursor, timezone);

  // Walk forward one local day at a time. The day count is bounded, and DST
  // safety comes for free because each candidate is resolved through
  // instantFromWallClock rather than by adding fixed 24h steps.
  const baseDate = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day));

  for (let dayOffset = 0; dayOffset <= MAX_DAYS; dayOffset++) {
    const probe = new Date(baseDate.getTime() + dayOffset * 86400000);
    const year = probe.getUTCFullYear();
    const month = probe.getUTCMonth() + 1;
    const day = probe.getUTCDate();
    const weekday = probe.getUTCDay();

    if (rule.dayOfWeek != null && weekday !== rule.dayOfWeek) {
      continue;
    }

    if (rule.dayOfMonth != null) {
      const clampedDay = Math.min(rule.dayOfMonth, daysInMonth(year, month));
      if (day !== clampedDay) {
        continue;
      }
    }

    const candidate = instantFromWallClock(year, month, day, time.hour, time.minute, timezone);
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  return null;
}

/** Human-readable local time, e.g. "Mon 10 Mar, 09:00". */
export function formatLocal(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Weekday names indexed 0=Sunday, for confirmation messages. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export interface ParsedTime {
  date: Date;
  /**
   * Set when the input looked like a recurring schedule rather than a single
   * instant, e.g. "every day at 09:00".
   */
  recurrence?: WallClockRule & { frequency: 'daily' | 'weekly' | 'monthly' };
}

const WEEKDAY_LOOKUP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Parses the time expressions people actually type. Deliberately conservative:
 * anything ambiguous returns null so the caller can ask for clarification
 * rather than silently scheduling the wrong thing.
 *
 * Supported: "in 30 minutes", "in 2 hours", "in 3 days", "tomorrow at 07:30",
 * "today at 18:00", "tonight at 8pm", "monday at 09:00", "09:00", "2026-03-05T09:00",
 * "every day at 09:00", "every monday at 09:00".
 */
export function parseNaturalTime(
  input: string,
  now: Date,
  timezone: string
): ParsedTime | null {
  const text = input.trim().toLowerCase();
  if (!text) {
    return null;
  }

  const recurring = /^every\s+(day|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(.+)$/.exec(text);
  if (recurring) {
    const target = parseClockTime(recurring[2]);
    if (!target) {
      return null;
    }

    if (recurring[1] === 'weekday') {
      // Weekdays are modelled as the next Monday at that time plus a weekly
      // rule; the scheduler only supports one weekday per reminder, so anchor
      // on Monday and let the user refine.
      return {
        date: nextOccurrence(
          { timeOfDay: formatTimeOfDay(target.hour, target.minute), dayOfWeek: 1 },
          now,
          timezone
        ) ?? now,
        recurrence: {
          frequency: 'weekly',
          timeOfDay: formatTimeOfDay(target.hour, target.minute),
          dayOfWeek: 1,
        },
      };
    }

    const weekday = WEEKDAY_LOOKUP[recurring[1]];
    if (recurring[1] === 'day') {
      return {
        date: nextOccurrence(
          { timeOfDay: formatTimeOfDay(target.hour, target.minute) },
          now,
          timezone
        ) ?? now,
        recurrence: { frequency: 'daily', timeOfDay: formatTimeOfDay(target.hour, target.minute) },
      };
    }

    return {
      date: nextOccurrence(
        { timeOfDay: formatTimeOfDay(target.hour, target.minute), dayOfWeek: weekday },
        now,
        timezone
      ) ?? now,
      recurrence: {
        frequency: 'weekly',
        timeOfDay: formatTimeOfDay(target.hour, target.minute),
        dayOfWeek: weekday,
      },
    };
  }

  const relative = /^in\s+(\d+)\s*(minute|min|hour|hr|day|week)s?$/.exec(text);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unit = relative[2];
    const multiplier = unit.startsWith('min')
      ? 60_000
      : unit.startsWith('hour') || unit === 'hr'
        ? 3_600_000
        : unit === 'day'
          ? 86_400_000
          : 604_800_000;
    return { date: new Date(now.getTime() + amount * multiplier) };
  }

  const dayAnchor = /^(today|tomorrow|tonight)\s+(?:at\s+)?(.+)$/.exec(text);
  if (dayAnchor) {
    const target = parseClockTime(dayAnchor[2]);
    if (!target) {
      return null;
    }
    const local = getLocalParts(now, timezone);
    const dayOffset = dayAnchor[1] === 'tomorrow' ? 1 : 0;
    const base = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
    const candidate = instantFromWallClock(
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      base.getUTCDate(),
      target.hour,
      target.minute,
      timezone
    );
    if (candidate.getTime() <= now.getTime()) {
      return null;
    }
    return { date: candidate };
  }

  const weekdayOnly = /^(?:on\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(.+))?$/.exec(text);
  if (weekdayOnly) {
    const target = weekdayOnly[2] ? parseClockTime(weekdayOnly[2]) : { hour: 9, minute: 0 };
    if (!target) {
      return null;
    }
    const occurrence = nextOccurrence(
      {
        timeOfDay: formatTimeOfDay(target.hour, target.minute),
        dayOfWeek: WEEKDAY_LOOKUP[weekdayOnly[1]],
      },
      now,
      timezone
    );
    return occurrence ? { date: occurrence } : null;
  }

  const clockOnly = parseClockTime(text);
  if (clockOnly) {
    const local = getLocalParts(now, timezone);
    let candidate = instantFromWallClock(
      local.year,
      local.month,
      local.day,
      clockOnly.hour,
      clockOnly.minute,
      timezone
    );
    if (candidate.getTime() <= now.getTime()) {
      const base = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
      candidate = instantFromWallClock(
        base.getUTCFullYear(),
        base.getUTCMonth() + 1,
        base.getUTCDate(),
        clockOnly.hour,
        clockOnly.minute,
        timezone
      );
    }
    return { date: candidate };
  }

  const iso = new Date(input.trim());
  if (!Number.isNaN(iso.getTime()) && /\d{4}-\d{2}-\d{2}/.test(input)) {
    return { date: iso };
  }

  return null;
}

/** Parses "18:00", "6pm", "6:30 pm", "9 am". */
export function parseClockTime(input: string): { hour: number; minute: number } | null {
  const text = input.trim().toLowerCase();

  const meridiem = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(text);
  if (meridiem) {
    let hour = Number.parseInt(meridiem[1], 10);
    const minute = meridiem[2] ? Number.parseInt(meridiem[2], 10) : 0;
    if (hour < 1 || hour > 12 || minute > 59) {
      return null;
    }
    if (meridiem[3] === 'pm' && hour !== 12) {
      hour += 12;
    }
    if (meridiem[3] === 'am' && hour === 12) {
      hour = 0;
    }
    return { hour, minute };
  }

  return parseTimeOfDay(text);
}
