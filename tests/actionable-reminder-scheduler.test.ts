import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import { ReminderScheduler, type ReminderDelivery } from '../src/services/reminder-scheduler.js';
import type { ReminderOccurrence } from '../src/services/reminder-action-store.js';

const TIMEZONE = 'Asia/Singapore';
const START = '2026-03-10T01:00:00.000Z';

function setup(iso = START) {
  const store = new InMemoryAssistantStore();
  let now = new Date(iso);
  const clock = { now: () => new Date(now) };
  const deliveries: ReminderDelivery[] = [];
  const scheduler = new ReminderScheduler({ store, timezone: TIMEZONE, clock, deliver: async (delivery) => { deliveries.push(delivery); } });
  return { store, scheduler, deliveries, clock, setTime: (next: string) => { now = new Date(next); } };
}

async function once(store: InMemoryAssistantStore, text = 'Take a break', userId = 1, when = START) {
  return store.createReminder({ userId, text, frequency: 'once', nextRunAt: when });
}

async function pending(store: InMemoryAssistantStore): Promise<ReminderOccurrence> {
  const [occurrence] = await store.listPendingReminderOccurrences(1);
  assert.ok(occurrence);
  return occurrence;
}

test('default reminders remain actionable without automatic follow-ups after delivery', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await once(store);
  await scheduler.tick();
  const occurrence = await pending(store);
  assert.equal(occurrence.status, 'pending');
  assert.equal(occurrence.notificationCount, 1);
  assert.equal(occurrence.nextNotificationAt, null);
  assert.equal(occurrence.leaseToken, null);
  setTime('2026-03-11T01:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
  const done = await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, 'done', new Date(START));
  assert.equal(done?.status, 'done', 'buttons remain valid after bookkeeping updates');
});

test('opt-in sends at most two hourly follow-ups for an unresolved occurrence', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  await scheduler.tick();
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-10T02:00:00.000Z');
  setTime('2026-03-10T01:59:59.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
  setTime('2026-03-10T02:00:00.000Z');
  await scheduler.tick();
  setTime('2026-03-10T03:00:00.000Z');
  await scheduler.tick();
  setTime('2026-03-10T04:00:00.000Z');
  await scheduler.tick();
  assert.deepEqual(deliveries.map(({ occurrence }) => occurrence.notificationKind), ['initial', 'followup', 'followup']);
  const occurrence = await pending(store);
  assert.equal(occurrence.followUpCount, 2);
  assert.equal(occurrence.notificationCount, 3);
  assert.equal(occurrence.nextNotificationAt, null);
});

test('quiet hours defer initial delivery until local morning without consuming follow-up budget', async () => {
  const { store, scheduler, deliveries, setTime } = setup('2026-03-10T15:00:00.000Z');
  await store.updateReminderPreferences(1, { quietHoursStart: '22:00', quietHoursEnd: '08:00', followUpsEnabled: true });
  await once(store, 'Evening', 1, '2026-03-10T15:00:00.000Z');
  let reservations = 0;
  const reserve = store.reserveReminderFollowUp.bind(store);
  store.reserveReminderFollowUp = async (...args) => { reservations++; return reserve(...args); };
  await scheduler.tick();
  assert.equal(deliveries.length, 0);
  const occurrence = await pending(store);
  assert.equal(occurrence.scheduledFor, '2026-03-10T15:00:00.000Z');
  assert.equal(occurrence.nextNotificationAt, '2026-03-11T00:00:00.000Z');
  assert.equal(occurrence.notificationCount, 0);
  assert.equal(occurrence.leaseToken, null);
  setTime('2026-03-10T23:59:59.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 0);
  setTime('2026-03-11T00:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].late, false, 'intentional quiet-hour deferral is not a missed delivery');
  assert.equal(reservations, 0);
});

test('quiet hours apply to both explicit snoozes and automatic follow-ups', async () => {
  for (const kind of ['snooze', 'followup'] as const) {
    const { store, scheduler, deliveries, setTime } = setup('2026-03-10T13:00:00.000Z');
    await store.updateReminderPreferences(1, { quietHoursStart: '22:00', quietHoursEnd: '08:00', followUpsEnabled: true });
    await once(store, kind, 1, '2026-03-10T13:00:00.000Z');
    await scheduler.tick();
    if (kind === 'snooze') {
      const occurrence = await pending(store);
      await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, 'snooze', new Date('2026-03-10T13:00:00.000Z'), '2026-03-10T14:00:00.000Z');
    }
    setTime('2026-03-10T14:00:00.000Z');
    await scheduler.tick();
    assert.equal(deliveries.length, 1, `${kind} respects quiet start boundary`);
    assert.equal((await pending(store)).nextNotificationAt, '2026-03-11T00:00:00.000Z');
    setTime('2026-03-11T00:00:00.000Z');
    await scheduler.tick();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].occurrence.notificationKind, kind);
  }
});

test('crossing the quiet-hours start during the final occurrence read defers the send', async () => {
  const beforeQuiet = '2026-03-10T13:59:59.000Z';
  const { store, scheduler, deliveries, setTime } = setup(beforeQuiet);
  await store.updateReminderPreferences(1, { quietHoursStart: '22:00', quietHoursEnd: '08:00' });
  await once(store, 'At the boundary', 1, beforeQuiet);
  const read = store.getReminderOccurrence.bind(store);
  store.getReminderOccurrence = async (...args) => {
    const occurrence = await read(...args);
    setTime('2026-03-10T14:00:01.000Z');
    return occurrence;
  };
  await scheduler.tick();
  assert.equal(deliveries.length, 0);
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-11T00:00:00.000Z');
  assert.equal((await pending(store)).leaseToken, null);
  store.getReminderOccurrence = read;
  setTime('2026-03-11T00:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
});

test('crossing local midnight after reserving a follow-up retries against the actual send-day budget', async () => {
  const start = '2026-03-10T14:59:59.000Z';
  const { store, scheduler, deliveries, setTime } = setup(start);
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store, 'Across midnight', 1, start);
  await scheduler.tick();
  const reserve = store.reserveReminderFollowUp.bind(store);
  const reservedDates: string[] = [];
  store.reserveReminderFollowUp = async (userId, localDate, maximum) => {
    reservedDates.push(localDate);
    return reserve(userId, localDate, maximum);
  };
  const read = store.getReminderOccurrence.bind(store);
  store.getReminderOccurrence = async (...args) => {
    const occurrence = await read(...args);
    setTime('2026-03-10T16:00:01.000Z');
    return occurrence;
  };
  setTime('2026-03-10T15:59:59.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1, 'a reservation from yesterday cannot authorize a send today');
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-10T16:00:01.000Z');
  assert.equal((await pending(store)).leaseToken, null);
  store.getReminderOccurrence = read;
  await scheduler.tick();
  assert.equal(deliveries.length, 2);
  assert.deepEqual(reservedDates, ['2026-03-10', '2026-03-11']);
  assert.equal((await pending(store)).followUpCount, 1);
});

test('five automatic attempts per local day are shared across occurrences and reset at local midnight', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  for (let index = 0; index < 6; index++) await once(store, `Reminder ${index}`);
  await scheduler.tick();
  assert.equal(deliveries.length, 6, 'initial deliveries do not use the automatic budget');
  setTime('2026-03-10T02:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 11);
  const occurrences = await store.listPendingReminderOccurrences(1);
  assert.equal(occurrences[5].nextNotificationAt, '2026-03-10T16:00:00.000Z');
  setTime('2026-03-10T03:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 11);
  setTime('2026-03-10T16:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 16, 'a new Singapore day has a fresh budget before the UTC day changes');
});

test('failed automatic sends consume the daily budget and defer after five attempts', async () => {
  const { store, scheduler, clock, setTime } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  await scheduler.tick();
  let attempts = 0;
  const failing = new ReminderScheduler({
    store, timezone: TIMEZONE, clock, deliver: async () => { attempts++; throw new Error('offline'); },
  });
  for (let index = 0; index < 6; index++) {
    setTime(new Date(Date.parse('2026-03-10T02:00:00.000Z') + index * 30_000).toISOString());
    await failing.tick();
  }
  assert.equal(attempts, 5);
  const occurrence = await pending(store);
  assert.equal(occurrence.followUpCount, 0, 'failed sends do not count as successful follow-ups');
  assert.equal(occurrence.nextNotificationAt, '2026-03-10T16:00:00.000Z');
});

test('explicit snoozes bypass the daily automatic budget and preserve the per-occurrence count', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  await scheduler.tick();
  setTime('2026-03-10T02:00:00.000Z');
  await scheduler.tick();
  for (let count = 1; count < 5; count++) await store.reserveReminderFollowUp(1, '2026-03-10', 5);
  const occurrence = await pending(store);
  await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, 'snooze', new Date('2026-03-10T02:00:00.000Z'), '2026-03-10T02:10:00.000Z');
  setTime('2026-03-10T02:10:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[2].occurrence.notificationKind, 'snooze');
  assert.equal((await pending(store)).followUpCount, 1);
  setTime('2026-03-10T03:10:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 3);
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-10T16:00:00.000Z');
});

test('snoozing after two successful follow-ups cannot restart automatic follow-ups', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  await scheduler.tick();
  setTime('2026-03-10T02:00:00.000Z');
  await scheduler.tick();
  setTime('2026-03-10T03:00:00.000Z');
  await scheduler.tick();
  const occurrence = await pending(store);
  await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, 'snooze', new Date('2026-03-10T03:00:00.000Z'), '2026-03-10T03:10:00.000Z');
  setTime('2026-03-10T03:10:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 4);
  assert.equal((await pending(store)).followUpCount, 2);
  assert.equal((await pending(store)).nextNotificationAt, null);
});

test('Done and Skip stop follow-ups without disabling the next recurring occurrence', async () => {
  for (const action of ['done', 'skip'] as const) {
    const { store, scheduler, deliveries, setTime } = setup();
    await store.updateReminderPreferences(1, { followUpsEnabled: true });
    await store.createReminder({ userId: 1, text: 'Daily', frequency: 'daily', timeOfDay: '09:00', nextRunAt: START });
    await scheduler.tick();
    const occurrence = await pending(store);
    await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, action, new Date(START));
    setTime('2026-03-10T02:00:00.000Z');
    await scheduler.tick();
    assert.equal(deliveries.length, 1);
    setTime('2026-03-11T01:00:00.000Z');
    await scheduler.tick();
    assert.equal(deliveries.length, 2);
    assert.notEqual(deliveries[0].occurrence.id, deliveries[1].occurrence.id);
    assert.equal(deliveries[1].occurrence.notificationKind, 'initial');
  }
});

test('an unresolved occurrence does not block the next day and old buttons still resolve only that occurrence', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await store.createReminder({ userId: 1, text: 'Daily', frequency: 'daily', timeOfDay: '09:00', nextRunAt: START });
  await scheduler.tick();
  setTime('2026-03-11T01:00:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 2);
  const [older, newer] = await store.listPendingReminderOccurrences(1);
  await store.actOnReminderOccurrence(older.id, 1, older.version, 'done', new Date('2026-03-11T01:00:00.000Z'));
  assert.equal((await store.getReminderOccurrence(newer.id, 1))?.status, 'pending');
  assert.equal((await store.listReminders(1))[0].nextRunAt, '2026-03-12T01:00:00.000Z');
});

test('opting out while an initial send is in flight prevents queued follow-ups', async () => {
  const { store, clock } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  const scheduler = new ReminderScheduler({ store, timezone: TIMEZONE, clock, deliver: async () => {
    await store.updateReminderPreferences(1, { followUpsEnabled: false });
  } });
  await scheduler.tick();
  assert.equal((await pending(store)).nextNotificationAt, null);
});

test('opting out cancels a follow-up already claimed before its external send', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  await scheduler.tick();
  setTime('2026-03-10T02:00:00.000Z');
  const getPreferences = store.getReminderPreferences.bind(store);
  store.getReminderPreferences = async (userId) => {
    const old = await getPreferences(userId);
    await store.updateReminderPreferences(userId, { followUpsEnabled: false });
    return old;
  };
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
  assert.equal((await pending(store)).nextNotificationAt, null);
});

test('an action before send invalidates the claimed lease; an in-flight send cannot undo Done', async () => {
  for (const phase of ['before', 'during'] as const) {
    const { store, clock } = setup();
    await store.updateReminderPreferences(1, { followUpsEnabled: true });
    await once(store);
    const complete = async () => {
      const occurrence = await pending(store);
      await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, 'done', new Date(START));
    };
    if (phase === 'before') {
      const getPreferences = store.getReminderPreferences.bind(store);
      store.getReminderPreferences = async (userId) => { await complete(); return getPreferences(userId); };
    }
    let sends = 0;
    const scheduler = new ReminderScheduler({ store, timezone: TIMEZONE, clock, deliver: async () => {
      sends++;
      if (phase === 'during') await complete();
    } });
    await scheduler.tick();
    assert.equal(sends, phase === 'before' ? 0 : 1);
    const saved = await store.getReminderOccurrence(1, 1);
    assert.equal(saved?.status, 'done');
    assert.equal(saved?.nextNotificationAt, null);
  }
});

test('snooze during an in-flight send survives its delivery bookkeeping', async () => {
  const { store, clock } = setup();
  await store.updateReminderPreferences(1, { followUpsEnabled: true });
  await once(store);
  const scheduler = new ReminderScheduler({ store, timezone: TIMEZONE, clock, deliver: async ({ occurrence }) => {
    await store.actOnReminderOccurrence(occurrence.id, 1, occurrence.version, 'snooze', new Date(START), '2026-03-10T01:10:00.000Z');
  } });
  await scheduler.tick();
  assert.equal((await pending(store)).notificationKind, 'snooze');
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-10T01:10:00.000Z');
});

test('concurrent schedulers materialize and deliver a due occurrence only once', async () => {
  const { store, clock } = setup();
  await once(store);
  let sends = 0;
  const options = { store, timezone: TIMEZONE, clock, deliver: async () => { sends++; } };
  const [left, right] = await Promise.all([new ReminderScheduler(options).tick(), new ReminderScheduler(options).tick()]);
  assert.equal(sends, 1);
  assert.equal(left.length + right.length, 1);
  assert.equal((await store.listPendingReminderOccurrences(1)).length, 1);
});

test('a crashed worker lease is retried only after expiry', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  const reminder = await once(store);
  const occurrence = await store.materializeReminder(reminder, null, new Date(START));
  assert.ok(occurrence);
  await store.claimReminderOccurrence(occurrence.id, occurrence.version, new Date(START), new Date('2026-03-10T01:01:00.000Z'), 'crashed-worker');
  await scheduler.tick();
  assert.equal(deliveries.length, 0);
  setTime('2026-03-10T01:01:00.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
  assert.equal((await pending(store)).leaseToken, null);
});

test('an expired lease is rechecked before external I/O', async () => {
  const { store, scheduler, deliveries, setTime } = setup();
  await once(store);
  const getPreferences = store.getReminderPreferences.bind(store);
  store.getReminderPreferences = async (userId) => {
    setTime('2026-03-10T01:01:00.000Z');
    return getPreferences(userId);
  };
  await scheduler.tick();
  assert.equal(deliveries.length, 0);
  store.getReminderPreferences = getPreferences;
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
});

test('one-off failures survive series deactivation and restart, with a thirty-second retry delay', async () => {
  const { store, clock, setTime, deliveries, scheduler } = setup();
  await once(store);
  const failing = new ReminderScheduler({ store, timezone: TIMEZONE, clock, deliver: async () => { throw new Error('offline'); } });
  assert.deepEqual(await failing.tick(), []);
  assert.equal((await store.listReminders(1)).length, 0);
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-10T01:00:30.000Z');
  setTime('2026-03-10T01:00:29.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 0);
  setTime('2026-03-10T01:00:30.000Z');
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
  assert.equal((await pending(store)).notificationCount, 1);
});

test('Telegram rate limits defer retries until retry_after', async () => {
  const { store, clock } = setup();
  await once(store);
  const scheduler = new ReminderScheduler({ store, timezone: TIMEZONE, clock, deliver: async () => {
    throw { response: { error_code: 429, parameters: { retry_after: 120 } } };
  } });
  await scheduler.tick();
  assert.equal((await pending(store)).nextNotificationAt, '2026-03-10T01:02:00.000Z');
});

test('owner filtering happens before batch limits for schedules and existing occurrences', async () => {
  const { store, clock } = setup();
  for (let index = 0; index < 25; index++) {
    const foreign = await once(store, `Foreign ${index}`, 2);
    await store.materializeReminder(foreign, null, new Date(START));
    await once(store, `Foreign schedule ${index}`, 2);
  }
  const owned = await once(store, 'Mine');
  const seen: number[] = [];
  const scheduler = new ReminderScheduler({ store, timezone: TIMEZONE, clock, userId: 1, deliver: async ({ occurrence }) => { seen.push(occurrence.reminderId); } });
  await scheduler.tick();
  assert.deepEqual(seen, [owned.id]);
  assert.equal((await store.listReminders(2)).length, 25, 'foreign schedules are not consumed');
});

test('an occurrence remains deliverable when polling the series store fails', async () => {
  const { store, scheduler, deliveries } = setup();
  const reminder = await once(store);
  await store.materializeReminder(reminder, null, new Date(START));
  store.listDueReminders = async () => { throw new Error('schedule query unavailable'); };
  await scheduler.tick();
  assert.equal(deliveries.length, 1);
});
