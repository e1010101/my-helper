import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTimeOfDay,
  getLocalParts,
  instantFromWallClock,
  localKey,
  nextOccurrence,
  parseClockTime,
  parseNaturalTime,
} from '../src/services/reminder-time.js';

const SINGAPORE = 'Asia/Singapore';
const NEW_YORK = 'America/New_York';

test('getLocalParts reports wall-clock fields in the target timezone', () => {
  // 2026-03-10T01:30:00Z is 09:30 in Singapore (UTC+8).
  const parts = getLocalParts(new Date('2026-03-10T01:30:00Z'), SINGAPORE);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 3);
  assert.equal(parts.day, 10);
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 30);
  assert.equal(parts.dayOfWeek, 2); // Tuesday
});

test('instantFromWallClock converts local time back to the right instant', () => {
  const instant = instantFromWallClock(2026, 3, 10, 9, 30, SINGAPORE);
  assert.equal(instant.toISOString(), '2026-03-10T01:30:00.000Z');
});

test('round trip local -> instant -> local is stable', () => {
  const instant = instantFromWallClock(2026, 6, 15, 18, 45, NEW_YORK);
  assert.equal(localKey(instant, NEW_YORK), '2026-06-15T18:45');
});

test('nextOccurrence finds the next matching local time today', () => {
  const now = new Date('2026-03-10T01:00:00Z'); // 09:00 Singapore
  const next = nextOccurrence({ timeOfDay: '18:00' }, now, SINGAPORE);
  assert.ok(next);
  assert.equal(localKey(next, SINGAPORE), '2026-03-10T18:00');
});

test('nextOccurrence rolls to tomorrow when today has passed', () => {
  const now = new Date('2026-03-10T12:00:00Z'); // 20:00 Singapore
  const next = nextOccurrence({ timeOfDay: '09:00' }, now, SINGAPORE);
  assert.ok(next);
  assert.equal(localKey(next, SINGAPORE), '2026-03-11T09:00');
});

test('nextOccurrence honours the weekday constraint', () => {
  // 2026-03-10 is a Tuesday; next Monday is 2026-03-16.
  const now = new Date('2026-03-10T01:00:00Z');
  const next = nextOccurrence({ timeOfDay: '09:00', dayOfWeek: 1 }, now, SINGAPORE);
  assert.ok(next);
  assert.equal(localKey(next, SINGAPORE), '2026-03-16T09:00');
  assert.equal(getLocalParts(next, SINGAPORE).dayOfWeek, 1);
});

test('nextOccurrence clamps monthly days that do not exist', () => {
  // From 31 January, a "31st" rule must land on the end of February.
  const now = new Date('2026-01-31T10:00:00Z');
  const next = nextOccurrence({ timeOfDay: '09:00', dayOfMonth: 31 }, now, SINGAPORE);
  assert.ok(next);
  assert.equal(localKey(next, SINGAPORE), '2026-02-28T09:00');
});

test('a daily reminder keeps its wall-clock time across a DST change', () => {
  // US DST starts 2026-03-08. A 09:00 daily reminder must stay at 09:00 local
  // before and after, even though the UTC offset changes.
  const before = new Date('2026-03-07T14:00:00Z'); // 09:00 EST
  assert.equal(localKey(before, NEW_YORK), '2026-03-07T09:00');

  const next = nextOccurrence({ timeOfDay: '09:00' }, before, NEW_YORK);
  assert.ok(next);
  assert.equal(localKey(next, NEW_YORK), '2026-03-08T09:00');

  const after = nextOccurrence({ timeOfDay: '09:00' }, next, NEW_YORK);
  assert.ok(after);
  assert.equal(localKey(after, NEW_YORK), '2026-03-09T09:00');

  // 09:00 EST is 14:00Z, but 09:00 EDT is 13:00Z: the offset really did shift.
  assert.equal(next.toISOString(), '2026-03-08T13:00:00.000Z');
});

test('nextOccurrence returns null for an unparseable time', () => {
  assert.equal(nextOccurrence({ timeOfDay: 'not-a-time' }, new Date(), SINGAPORE), null);
});

test('parseClockTime handles 24h and meridiem forms', () => {
  assert.deepEqual(parseClockTime('09:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseClockTime('9:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseClockTime('6pm'), { hour: 18, minute: 0 });
  assert.deepEqual(parseClockTime('6:30 pm'), { hour: 18, minute: 30 });
  assert.deepEqual(parseClockTime('12am'), { hour: 0, minute: 0 });
  assert.deepEqual(parseClockTime('12pm'), { hour: 12, minute: 0 });
  assert.equal(parseClockTime('25:00'), null);
  assert.equal(parseClockTime('13pm'), null);
  assert.equal(parseClockTime('later'), null);
});

test('formatTimeOfDay pads to HH:MM', () => {
  assert.equal(formatTimeOfDay(9, 5), '09:05');
  assert.equal(formatTimeOfDay(18, 0), '18:00');
});

test('parseNaturalTime handles relative offsets', () => {
  const now = new Date('2026-03-10T01:00:00Z');
  assert.equal(parseNaturalTime('in 30 minutes', now, SINGAPORE)?.date.toISOString(), '2026-03-10T01:30:00.000Z');
  assert.equal(parseNaturalTime('in 2 hours', now, SINGAPORE)?.date.toISOString(), '2026-03-10T03:00:00.000Z');
  assert.equal(parseNaturalTime('in 1 day', now, SINGAPORE)?.date.toISOString(), '2026-03-11T01:00:00.000Z');
  assert.equal(parseNaturalTime('in 1 week', now, SINGAPORE)?.date.toISOString(), '2026-03-17T01:00:00.000Z');
});

test('parseNaturalTime handles today/tomorrow/tonight', () => {
  const now = new Date('2026-03-10T01:00:00Z'); // 09:00 Singapore
  assert.equal(parseNaturalTime('tomorrow at 07:30', now, SINGAPORE)?.date.toISOString(), '2026-03-10T23:30:00.000Z');
  assert.equal(parseNaturalTime('tonight at 8pm', now, SINGAPORE)?.date.toISOString(), '2026-03-10T12:00:00.000Z');
  assert.equal(parseNaturalTime('today at 20:00', now, SINGAPORE)?.date.toISOString(), '2026-03-10T12:00:00.000Z');
});

test('parseNaturalTime rejects a time that already passed today', () => {
  const now = new Date('2026-03-10T12:00:00Z'); // 20:00 Singapore
  assert.equal(parseNaturalTime('today at 09:00', now, SINGAPORE), null);
});

test('parseNaturalTime handles a bare clock time, rolling to tomorrow if needed', () => {
  const now = new Date('2026-03-10T01:00:00Z'); // 09:00 Singapore
  // 18:00 is still ahead today.
  assert.equal(parseNaturalTime('18:00', now, SINGAPORE)?.date.toISOString(), '2026-03-10T10:00:00.000Z');
  // 08:00 already passed, so it rolls to tomorrow.
  assert.equal(parseNaturalTime('08:00', now, SINGAPORE)?.date.toISOString(), '2026-03-11T00:00:00.000Z');
  assert.equal(localKey(parseNaturalTime('08:00', now, SINGAPORE)!.date, SINGAPORE), '2026-03-11T08:00');
});

test('parseNaturalTime handles weekday names', () => {
  const now = new Date('2026-03-10T01:00:00Z'); // Tuesday
  const monday = parseNaturalTime('monday at 09:00', now, SINGAPORE);
  assert.ok(monday);
  assert.equal(localKey(monday.date, SINGAPORE), '2026-03-16T09:00');
  assert.equal(monday.recurrence, undefined);
});

test('parseNaturalTime recognises recurring schedules', () => {
  const now = new Date('2026-03-10T01:00:00Z'); // Tuesday 09:00 Singapore

  const daily = parseNaturalTime('every day at 09:00', now, SINGAPORE);
  assert.equal(daily?.recurrence?.frequency, 'daily');
  assert.equal(daily?.recurrence?.timeOfDay, '09:00');
  assert.equal(localKey(daily!.date, SINGAPORE), '2026-03-11T09:00');

  const weekly = parseNaturalTime('every monday at 18:30', now, SINGAPORE);
  assert.equal(weekly?.recurrence?.frequency, 'weekly');
  assert.equal(weekly?.recurrence?.dayOfWeek, 1);
  assert.equal(localKey(weekly!.date, SINGAPORE), '2026-03-16T18:30');
});

test('parseNaturalTime accepts ISO timestamps and rejects nonsense', () => {
  const now = new Date('2026-03-10T01:00:00Z');
  assert.equal(parseNaturalTime('2026-04-01T09:00:00Z', now, SINGAPORE)?.date.toISOString(), '2026-04-01T09:00:00.000Z');
  assert.equal(parseNaturalTime('sometime soon', now, SINGAPORE), null);
  assert.equal(parseNaturalTime('', now, SINGAPORE), null);
});
