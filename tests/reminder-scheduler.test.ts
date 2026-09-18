import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import { ReminderScheduler, type ReminderDelivery } from '../src/services/reminder-scheduler.js';
import { instantFromWallClock, localKey } from '../src/services/reminder-time.js';

const SINGAPORE = 'Asia/Singapore';

function fixedClock(iso: string) {
  return { now: () => new Date(iso) };
}

test('delivers a one-off reminder that is due and deactivates it', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T01:00:00Z');

  await store.createReminder({
    userId: 1,
    text: 'Take the bins out',
    nextRunAt: '2026-03-10T00:59:00Z',
    frequency: 'once',
  });

  const deliveries: ReminderDelivery[] = [];
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async (delivery) => {
      deliveries.push(delivery);
    },
  });

  const delivered = await scheduler.tick();

  assert.equal(delivered.length, 1);
  assert.equal(deliveries[0].reminder.text, 'Take the bins out');
  assert.equal(deliveries[0].late, false, 'one minute late is within the threshold');

  const remaining = await store.listReminders(1);
  assert.equal(remaining.length, 0, 'one-off reminders are deactivated after delivery');
});

test('reschedules a recurring reminder to its next occurrence', async () => {
  const store = new InMemoryAssistantStore();
  // 2026-03-10T01:00:00Z is 09:00 in Singapore.
  const now = new Date('2026-03-10T01:00:00Z');

  const reminder = await store.createReminder({
    userId: 1,
    text: 'Standup',
    nextRunAt: '2026-03-10T01:00:00Z',
    frequency: 'daily',
    timeOfDay: '09:00',
  });

  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async () => {},
  });

  await scheduler.tick();

  const [updated] = await store.listReminders(1);
  assert.equal(updated.active, true, 'recurring reminders stay active');
  assert.equal(localKey(new Date(updated.nextRunAt), SINGAPORE), '2026-03-11T09:00');
  assert.ok(updated.lastSentAt, 'delivery is stamped');
  assert.equal(reminder.id, updated.id);
});

test('does not deliver the same occurrence twice', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T01:00:00Z');

  await store.createReminder({
    userId: 1,
    text: 'Daily',
    nextRunAt: now.toISOString(),
    frequency: 'daily',
    timeOfDay: '09:00',
  });

  let delivered = 0;
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async () => {
      delivered += 1;
    },
  });

  await scheduler.tick();
  await scheduler.tick();

  assert.equal(delivered, 1);
});

test('flags a reminder missed while the bot was offline', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T05:00:00Z');

  await store.createReminder({
    userId: 1,
    text: 'Was due hours ago',
    nextRunAt: '2026-03-10T01:00:00Z',
    frequency: 'once',
  });

  const deliveries: ReminderDelivery[] = [];
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async (delivery) => {
      deliveries.push(delivery);
    },
  });

  await scheduler.tick();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].late, true);
});

test('one failing delivery does not stop the others', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T01:00:00Z');

  await store.createReminder({ userId: 1, text: 'First', nextRunAt: now.toISOString(), frequency: 'once' });
  await store.createReminder({ userId: 1, text: 'Second', nextRunAt: now.toISOString(), frequency: 'once' });

  const seen: string[] = [];
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async ({ reminder }) => {
      if (reminder.text === 'First') {
        throw new Error('telegram exploded');
      }
      seen.push(reminder.text);
    },
  });

  await scheduler.tick();

  assert.deepEqual(seen, ['Second']);
});

test('inactive reminders are never delivered', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T01:00:00Z');

  const reminder = await store.createReminder({
    userId: 1,
    text: 'Cancelled',
    nextRunAt: now.toISOString(),
    frequency: 'once',
  });
  await store.cancelReminder(reminder.id, 1);

  let delivered = 0;
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async () => {
      delivered += 1;
    },
  });

  await scheduler.tick();
  assert.equal(delivered, 0);
});

test('start/stop is idempotent and does not throw without timers running', () => {
  const store = new InMemoryAssistantStore();
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    deliver: async () => {},
  });

  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);

  scheduler.stop();
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
});

test('a reminder with no future occurrence is deactivated instead of looping', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T01:00:00Z');

  await store.createReminder({
    userId: 1,
    text: 'Broken schedule',
    nextRunAt: now.toISOString(),
    frequency: 'daily',
    timeOfDay: 'not-a-time',
  });

  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async () => {},
  });

  await scheduler.tick();

  const reminders = await store.listReminders(1, true);
  assert.equal(reminders[0].active, false);
});

test('housekeeping runs once per poll and never breaks delivery', async () => {
  const store = new InMemoryAssistantStore();
  const now = new Date('2026-03-10T01:00:00Z');
  await store.createReminder({ userId: 1, text: 'Due', nextRunAt: now.toISOString(), frequency: 'once' });

  let polls = 0;
  const delivered: string[] = [];
  const scheduler = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(now.toISOString()),
    deliver: async ({ reminder }) => {
      delivered.push(reminder.text);
    },
    onPoll: () => {
      polls += 1;
      throw new Error('housekeeping is broken');
    },
  });

  await scheduler.tick();
  await scheduler.tick();

  assert.equal(polls, 2);
  // A throwing hook must not stop reminders from being delivered.
  assert.deepEqual(delivered, ['Due']);
});

test('reminder times are timezone-correct end to end', async () => {
  const store = new InMemoryAssistantStore();
  const scheduledFor = instantFromWallClock(2026, 3, 11, 9, 0, SINGAPORE);

  const reminder = await store.createReminder({
    userId: 1,
    text: 'Timezone check',
    nextRunAt: scheduledFor.toISOString(),
    frequency: 'once',
  });

  assert.equal(localKey(new Date(reminder.nextRunAt), SINGAPORE), '2026-03-11T09:00');

  // Not due a minute early...
  const early = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(new Date(scheduledFor.getTime() - 60_000).toISOString()),
    deliver: async () => {},
  });
  await early.tick();
  assert.equal((await store.listReminders(1)).length, 1);

  // ...but delivered on time.
  let delivered = 0;
  const onTime = new ReminderScheduler({
    store,
    timezone: SINGAPORE,
    clock: fixedClock(scheduledFor.toISOString()),
    deliver: async () => {
      delivered += 1;
    },
  });
  await onTime.tick();
  assert.equal(delivered, 1);
});
