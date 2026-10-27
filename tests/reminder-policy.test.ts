import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultReminderPreferences } from '../src/services/reminder-action-store.js';
import { nextLocalDay, quietHoursEnd, snoozeUntil, validateReminderPreferences } from '../src/services/reminder-policy.js';

const prefs = (start: string | null = '22:00', end: string | null = '08:00') => ({
  ...defaultReminderPreferences(1), quietHoursStart: start, quietHoursEnd: end,
});

test('quiet hours are opt-in and overnight boundaries are inclusive/exclusive', () => {
  assert.equal(quietHoursEnd(new Date('2026-10-26T15:00:00Z'), defaultReminderPreferences(1), 'Asia/Singapore'), null);
  assert.equal(quietHoursEnd(new Date('2026-10-26T13:59:59Z'), prefs(), 'Asia/Singapore'), null);
  assert.equal(quietHoursEnd(new Date('2026-10-26T14:00:00Z'), prefs(), 'Asia/Singapore')?.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(quietHoursEnd(new Date('2026-10-26T23:59:59.999Z'), prefs(), 'Asia/Singapore')?.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(quietHoursEnd(new Date('2026-10-27T00:00:00Z'), prefs(), 'Asia/Singapore'), null);
});

test('same-day quiet intervals end today and do not suppress the rest of the day', () => {
  assert.equal(quietHoursEnd(new Date('2026-10-26T02:15:30Z'), prefs('09:00', '12:00'), 'Asia/Singapore')?.toISOString(), '2026-10-26T04:00:00.000Z');
  assert.equal(quietHoursEnd(new Date('2026-10-26T05:00:00Z'), prefs('09:00', '12:00'), 'Asia/Singapore'), null);
});

test('quiet hours resolve spring gaps and the second instance of fall-back times', () => {
  assert.equal(quietHoursEnd(new Date('2026-03-08T06:45:00Z'), prefs('22:00', '02:30'), 'America/New_York')?.toISOString(), '2026-03-08T07:00:00.000Z');
  assert.equal(quietHoursEnd(new Date('2026-11-01T06:15:00Z'), prefs('22:00', '01:30'), 'America/New_York')?.toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(quietHoursEnd(new Date('2026-11-01T05:15:00Z'), prefs('22:00', '01:30'), 'America/New_York')?.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('half-hour daylight-saving gaps do not return a past quiet-hours boundary', () => {
  assert.equal(quietHoursEnd(new Date('2026-10-03T15:15:00Z'), prefs('22:00', '02:15'), 'Australia/Lord_Howe')?.toISOString(), '2026-10-03T15:30:00.000Z');
});

test('settings reject malformed, partial and all-day quiet windows', () => {
  for (const settings of [prefs('24:00'), prefs('9:00'), prefs('12:60'), prefs('22:00', null), prefs(null, '08:00'), prefs('08:00', '08:00')]) {
    assert.throws(() => validateReminderPreferences(settings));
  }
  assert.throws(() => validateReminderPreferences({ ...prefs(), followUpsEnabled: 'on' as unknown as boolean }));
  for (const userId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateReminderPreferences({ ...prefs(), userId }), /owner/);
  }
  assert.doesNotThrow(() => validateReminderPreferences(prefs(null, null)));
});

test('short snoozes use elapsed minutes while Tomorrow uses local 09:00', () => {
  const now = new Date('2026-10-26T15:57:31Z');
  assert.equal(snoozeUntil(now, '10m', 'Asia/Singapore').toISOString(), '2026-10-26T16:07:31.000Z');
  assert.equal(snoozeUntil(now, '1h', 'Asia/Singapore').toISOString(), '2026-10-26T16:57:31.000Z');
  assert.equal(snoozeUntil(now, 'tomorrow', 'Asia/Singapore').toISOString(), '2026-10-27T01:00:00.000Z');
  assert.equal(snoozeUntil(new Date('2026-03-07T17:00:00Z'), 'tomorrow', 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(snoozeUntil(new Date('2026-10-31T16:00:00Z'), 'tomorrow', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
});

test('daily budgets reset at local midnight, including daylight-saving changes', () => {
  assert.equal(nextLocalDay(new Date('2026-10-26T18:00:00Z'), 'Asia/Singapore').toISOString(), '2026-10-27T16:00:00.000Z');
  assert.equal(nextLocalDay(new Date('2026-03-08T06:00:00Z'), 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(nextLocalDay(new Date('2026-11-01T05:00:00Z'), 'America/New_York').toISOString(), '2026-11-02T05:00:00.000Z');
});
