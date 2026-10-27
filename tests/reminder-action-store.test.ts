import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssistantStore } from '../src/services/assistant-store.js';
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';
import { SupabaseAssistantStore } from '../src/services/supabase-assistant-store.js';
import type { Reminder } from '../src/types/assistant.js';

const now = new Date('2026-10-27T01:00:00.000Z');
const later = '2026-10-27T02:00:00.000Z';
const tomorrow = '2026-10-28T01:00:00.000Z';
const leaseEnd = new Date('2026-10-27T01:05:00.000Z');

// Exercise the production Supabase adapter against actual PostgreSQL statements,
// without networking. This deliberately implements only the fluent operators
// used below; unknown adapter calls fail instead of silently doing nothing.
function postgresClient(pg: PGlite): SupabaseClient {
  type Result = { data: unknown; error: { message: string } | null };
  function builder(table?: string, rpc?: { name: string; args: Record<string, unknown> }) {
    const values: unknown[] = [];
    const where: string[] = [];
    const order: string[] = [];
    let limit: number | undefined;
    let mutation: Record<string, unknown> | undefined;
    let insert = false;
    let single = false;
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const column = (name: string) => { assert.match(name, /^[a-z_]+$/); return `"${name}"`; };
    const run = async (): Promise<Result> => {
      try {
        let sql: string;
        if (rpc) {
          sql = `SELECT * FROM ${column(rpc.name)}(${Object.entries(rpc.args).map(([key, value]) => `${column(key)} => ${bind(value !== null && typeof value === 'object' ? JSON.stringify(value) : value)}`).join(',')})`;
        } else {
          const suffix = `${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
          if (mutation) {
            if (insert) sql = `INSERT INTO ${column(table!)} (${Object.keys(mutation).map(column).join(',')}) VALUES (${Object.values(mutation).map(bind).join(',')}) RETURNING *`;
            else sql = `UPDATE ${column(table!)} SET ${Object.entries(mutation).map(([key, value]) => `${column(key)} = ${bind(value)}`).join(',')}${suffix} RETURNING *`;
          } else sql = `SELECT * FROM ${column(table!)}${suffix}${order.length ? ` ORDER BY ${order.join(',')}` : ''}${limit === undefined ? '' : ` LIMIT ${limit}`}`;
        }
        const result = await pg.query(sql, values);
        const rows = JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[];
        let data: unknown = single ? rows[0] ?? null : rows;
        if (rpc && rows.length === 1 && Object.keys(rows[0]).length === 1 && rpc.name in rows[0]) data = rows[0][rpc.name];
        return { data, error: null };
      } catch (error) { return { data: null, error: { message: String(error) } }; }
    };
    const query = {
      select: (_selection?: string) => query,
      eq: (key: string, value: unknown) => { where.push(`${column(key)} = ${bind(value)}`); return query; },
      lte: (key: string, value: unknown) => { where.push(`${column(key)} <= ${bind(value)}`); return query; },
      or: (expression: string) => {
        const prefix = 'lease_until.is.null,lease_until.lte.';
        assert.ok(expression.startsWith(prefix));
        where.push(`(lease_until IS NULL OR lease_until <= ${bind(expression.slice(prefix.length))})`);
        return query;
      },
      order: (key: string, options?: { ascending: boolean }) => { order.push(`${column(key)} ${options?.ascending === false ? 'DESC' : 'ASC'}`); return query; },
      limit: (count: number) => { assert.ok(Number.isInteger(count) && count >= 0); limit = count; return query; },
      insert: (row: Record<string, unknown>) => { mutation = row; insert = true; return query; },
      update: (row: Record<string, unknown>) => { mutation = row; return query; },
      maybeSingle: () => { single = true; return query; },
      single: () => { single = true; return query; },
      then: ((resolve, reject) => run().then(resolve, reject)) as PromiseLike<Result>['then'],
    };
    return query;
  }
  return { from: (table: string) => builder(table), rpc: (name: string, args: Record<string, unknown>) => builder(undefined, { name, args }) } as unknown as SupabaseClient;
}

async function create(store: AssistantStore, frequency: Reminder['frequency'] = 'once', userId = 1): Promise<Reminder> {
  return store.createReminder({ userId, text: 'Original reminder', nextRunAt: now.toISOString(), frequency, timeOfDay: frequency === 'daily' ? '09:00' : null });
}

for (const backend of ['memory', 'postgres'] as const) {
  test(`${backend}: actionable reminder persistence contract`, async (t) => {
    const pg = backend === 'postgres' ? new PGlite() : undefined;
    try {
      if (pg) {
        await pg.exec('CREATE ROLE service_role NOLOGIN BYPASSRLS;');
        await pg.exec(await readFile(new URL('../docs/database-schema.sql', import.meta.url), 'utf8'));
      }
      const fresh = async (): Promise<AssistantStore> => {
        if (!pg) return new InMemoryAssistantStore();
        await pg.exec('RESET ROLE; TRUNCATE reminders, reminder_preferences, reminder_followup_daily_usage RESTART IDENTITY CASCADE; SET ROLE service_role;');
        return new SupabaseAssistantStore(postgresClient(pg));
      };

      await t.test('materialization is single-winner, snapshots text and advances independently of old occurrences', async () => {
        const store = await fresh();
        const reminder = structuredClone(await create(store, 'daily'));
        const results = await Promise.all([store.materializeReminder(reminder, tomorrow, now), store.materializeReminder(reminder, tomorrow, now)]);
        assert.equal(results.filter(Boolean).length, 1);
        const first = results.find(Boolean)!;
        await store.updateReminder(reminder.id, 1, { text: 'Changed series' });
        assert.equal((await store.getReminderOccurrence(first.id, 1))?.text, 'Original reminder');
        const next = (await store.listDueReminders(new Date(tomorrow)))[0];
        assert.equal(next.nextRunAt, tomorrow);
        const second = await store.materializeReminder(next, '2026-10-29T01:00:00Z', new Date(tomorrow));
        assert.equal(second?.text, 'Changed series');
        assert.equal((await store.listPendingReminderOccurrences(1)).length, 2);
        assert.equal((await store.actOnReminderOccurrence(first.id, 1, first.version, 'done', new Date(tomorrow)))?.status, 'done');
        assert.equal((await store.getReminderOccurrence(second!.id, 1))?.status, 'pending');
      });

      await t.test('schedule and owner CAS reject stale work, and owner filtering precedes limits', async () => {
        const store = await fresh();
        await create(store, 'once', 2);
        const reminder = structuredClone(await create(store, 'daily'));
        assert.deepEqual((await store.listDueReminders(now, 1, 1)).map((row) => row.id), [reminder.id]);
        assert.equal(await store.materializeReminder({ ...reminder, userId: 2 }, tomorrow, now), null);
        await store.updateReminder(reminder.id, 1, { text: 'Updated', schedule: { frequency: 'daily', nextRunAt: tomorrow, timeOfDay: '09:00' } });
        assert.equal(await store.materializeReminder(reminder, tomorrow, now), null);
        assert.equal((await store.listPendingReminderOccurrences(1)).length, 0);
        const other = (await store.listDueReminders(now, 1, 2))[0];
        await store.materializeReminder(other, null, now);
        const own = await create(store);
        const occurrence = await store.materializeReminder(own, null, now);
        assert.deepEqual((await store.listDueReminderOccurrences(now, 1, 1)).map((row) => row.id), [occurrence!.id]);
        assert.equal(await store.getReminderOccurrence(occurrence!.id, 2), null);
      });

      await t.test('leases have one winner, can expire, and stale finishes cannot overwrite an action', async () => {
        const store = await fresh();
        const occurrence = (await store.materializeReminder(await create(store), null, now))!;
        const claims = await Promise.all(['first', 'second'].map((token) => store.claimReminderOccurrence(occurrence.id, 0, now, leaseEnd, token)));
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal((await store.listDueReminderOccurrences(now)).length, 0);
        const expired = await store.claimReminderOccurrence(occurrence.id, 0, leaseEnd, new Date(later), 'expired-retry');
        assert.ok(expired);
        assert.equal(await store.actOnReminderOccurrence(occurrence.id, 2, 0, 'done', now), null);
        const snoozed = await store.actOnReminderOccurrence(occurrence.id, 1, 0, 'snooze', now, later);
        assert.equal(snoozed?.version, 1);
        assert.equal(snoozed?.notificationKind, 'snooze');
        assert.equal(snoozed?.leaseToken, null);
        assert.equal(await store.finishReminderOccurrence(occurrence.id, 0, 'expired-retry', now, null), false);
        assert.equal(await store.deferReminderOccurrence(occurrence.id, 0, 'expired-retry', null), false);
        assert.equal(await store.actOnReminderOccurrence(occurrence.id, 1, 0, 'done', now), null);
        assert.equal(await store.claimReminderOccurrence(occurrence.id, 1, now, leaseEnd, 'early'), null);
        const skipped = await store.actOnReminderOccurrence(occurrence.id, 1, 1, 'skip', now);
        assert.equal(skipped?.status, 'skipped');
        assert.equal(skipped?.completedAt, now.toISOString());
        assert.equal(await store.actOnReminderOccurrence(occurrence.id, 1, 2, 'done', now), null);
        await assert.rejects(store.actOnReminderOccurrence(occurrence.id, 1, 2, 'snooze', now, now.toISOString()), /future/i);
      });

      await t.test('delivery retains callback version, counts only followups and never changes the advanced schedule', async () => {
        const store = await fresh();
        await store.updateReminderPreferences(1, { followUpsEnabled: true });
        const reminder = await create(store, 'daily');
        const occurrence = (await store.materializeReminder(reminder, tomorrow, now))!;
        await store.claimReminderOccurrence(occurrence.id, 0, now, leaseEnd, 'initial');
        assert.equal(await store.finishReminderOccurrence(occurrence.id, 0, 'wrong', now, later), false);
        assert.equal(await store.finishReminderOccurrence(occurrence.id, 0, 'initial', now, later), true);
        let saved = (await store.getReminderOccurrence(occurrence.id, 1))!;
        assert.equal(saved.version, 0);
        assert.equal(saved.notificationCount, 1);
        assert.equal(saved.followUpCount, 0);
        assert.equal((await store.getReminder(reminder.id, 1))?.nextRunAt, tomorrow);
        for (let count = 1; count <= 2; count++) {
          const sentAt = new Date(`2026-10-27T0${count + 1}:00:00Z`);
          await store.claimReminderOccurrence(occurrence.id, 0, sentAt, new Date(sentAt.getTime() + 300_000), `followup${count}`);
          assert.equal(await store.finishReminderOccurrence(occurrence.id, 0, `followup${count}`, sentAt, new Date(sentAt.getTime() + 3_600_000).toISOString()), true);
          saved = (await store.getReminderOccurrence(occurrence.id, 1))!;
          assert.equal(saved.followUpCount, count);
        }
        assert.equal(saved.notificationCount, 3);
        assert.equal(saved.nextNotificationAt, null);
        assert.equal((await store.actOnReminderOccurrence(occurrence.id, 1, 0, 'done', now))?.status, 'done');
      });

      await t.test('cancellation covers inactive one-offs and every pending recurrence and invalidates leases', async () => {
        const store = await fresh();
        const reminder = await create(store);
        const occurrence = (await store.materializeReminder(reminder, null, now))!;
        assert.equal(await store.getReminder(reminder.id, 1), null);
        await store.claimReminderOccurrence(occurrence.id, 0, now, leaseEnd, 'send');
        assert.equal(await store.cancelReminder(reminder.id, 2), false);
        assert.equal(await store.cancelReminder(reminder.id, 1), true);
        assert.equal(await store.cancelReminder(reminder.id, 1), false);
        assert.equal((await store.getReminderOccurrence(occurrence.id, 1))?.status, 'cancelled');
        assert.equal(await store.finishReminderOccurrence(occurrence.id, 0, 'send', now, null), false);
        const daily = await create(store, 'daily');
        await store.materializeReminder(daily, tomorrow, now);
        const due = (await store.listDueReminders(new Date(tomorrow)))[0];
        await store.materializeReminder(due, '2026-10-29T01:00:00Z', new Date(tomorrow));
        assert.equal(await store.cancelReminder(daily.id, 1), true);
        assert.equal((await store.listPendingReminderOccurrences(1)).length, 0);
      });

      await t.test('opt-out stops queued followups and prevents in-flight initial sends from rearming them', async () => {
        const store = await fresh();
        assert.deepEqual(await store.getReminderPreferences(1), { userId: 1, quietHoursStart: null, quietHoursEnd: null, followUpsEnabled: false });
        await store.updateReminderPreferences(1, { followUpsEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' });
        const queued = (await store.materializeReminder(await create(store), null, now))!;
        await store.claimReminderOccurrence(queued.id, 0, now, leaseEnd, 'send');
        await store.finishReminderOccurrence(queued.id, 0, 'send', now, later);
        await store.claimReminderOccurrence(queued.id, 0, new Date(later), new Date('2026-10-27T02:05:00Z'), 'followup');
        const initial = (await store.materializeReminder(await create(store), null, now))!;
        await store.claimReminderOccurrence(initial.id, 0, now, leaseEnd, 'initial');
        const snoozed = (await store.materializeReminder(await create(store), null, now))!;
        await store.actOnReminderOccurrence(snoozed.id, 1, 0, 'snooze', now, later);
        await store.updateReminderPreferences(1, { followUpsEnabled: false });
        const cleared = (await store.getReminderOccurrence(queued.id, 1))!;
        assert.equal(cleared.nextNotificationAt, null);
        assert.equal(cleared.leaseToken, null);
        assert.equal(cleared.version, 0);
        assert.equal(await store.finishReminderOccurrence(queued.id, 0, 'followup', new Date(later), tomorrow), false);
        assert.equal(await store.finishReminderOccurrence(initial.id, 0, 'initial', now, later), true);
        assert.equal((await store.getReminderOccurrence(initial.id, 1))?.nextNotificationAt, null);
        assert.equal((await store.getReminderOccurrence(snoozed.id, 1))?.nextNotificationAt, later);
        await store.updateReminderPreferences(1, { followUpsEnabled: true });
        assert.equal((await store.getReminderOccurrence(queued.id, 1))?.nextNotificationAt, null);
        assert.equal((await store.getReminderPreferences(1)).quietHoursStart, '22:00');
        await assert.rejects(store.updateReminderPreferences(1, { quietHoursStart: null }));
        await assert.rejects(store.updateReminderPreferences(1, { quietHoursStart: '25:00' }));
        await assert.rejects(store.updateReminderPreferences(1, { quietHoursStart: '07:00' }));
        assert.equal((await store.getReminderPreferences(1)).quietHoursStart, '22:00');
        assert.equal((await store.updateReminderPreferences(1, { quietHoursStart: null, quietHoursEnd: null })).quietHoursEnd, null);
      });

      await t.test('deferrals preserve delivery counters and are versioned and owner budgets are atomic', async () => {
        const store = await fresh();
        const occurrence = (await store.materializeReminder(await create(store), null, now))!;
        await store.claimReminderOccurrence(occurrence.id, 0, now, leaseEnd, 'quiet');
        assert.equal(await store.deferReminderOccurrence(occurrence.id, 0, 'quiet', later), true);
        assert.equal(await store.deferReminderOccurrence(occurrence.id, 0, 'quiet', null), false);
        const deferred = (await store.getReminderOccurrence(occurrence.id, 1))!;
        assert.equal(deferred.notificationCount, 0);
        assert.equal(deferred.version, 0);
        assert.equal(deferred.notificationKind, 'initial');
        assert.equal(deferred.nextNotificationAt, later);
        const budgets = await Promise.all(Array.from({ length: 12 }, () => store.reserveReminderFollowUp(1, '2026-10-27', 5)));
        assert.equal(budgets.filter(Boolean).length, 5);
        assert.equal(await store.reserveReminderFollowUp(2, '2026-10-27', 5), true);
        assert.equal(await store.reserveReminderFollowUp(1, '2026-10-28', 5), true);
        await assert.rejects(store.reserveReminderFollowUp(1, '2026-02-30', 5));
        await assert.rejects(store.reserveReminderFollowUp(1, '2026-10-27', 6));
      });

      await t.test('preferences and budgets reject invalid owners consistently', async () => {
        const store = await fresh();
        for (const owner of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
          await assert.rejects(store.getReminderPreferences(owner), /owner/i);
          await assert.rejects(store.updateReminderPreferences(owner, {}), /owner/i);
          await assert.rejects(store.reserveReminderFollowUp(owner, '2026-10-27', 5), /owner/i);
        }
      });

      if (pg) await t.test('SQL itself enforces owner integrity, preference types and budgets without adapter validation', async () => {
        const store = await fresh();
        const reminder = await create(store);
        await assert.rejects(pg.query("INSERT INTO reminder_occurrences(reminder_id,user_id,text,scheduled_for) VALUES ($1,2,'foreign owner',$2)", [reminder.id, now.toISOString()]), /foreign key/i);
        await assert.rejects(pg.query("SELECT * FROM update_reminder_preferences(1, '{\"follow_ups_enabled\":null}'::jsonb)"), /Invalid reminder preferences/);
        await assert.rejects(pg.query("SELECT * FROM update_reminder_preferences(1, '{\"quiet_hours_start\":2200}'::jsonb)"), /Invalid reminder preferences/);
        await assert.rejects(pg.query("SELECT * FROM update_reminder_preferences(1, '{\"quiet_hours_start\":\"22:00\"}'::jsonb)"), /check constraint/);
        await assert.rejects(pg.query("SELECT reserve_reminder_follow_up(1, '2026-10-27', 6)"), /between 1 and 5/);
        await assert.rejects(pg.query("SELECT reserve_reminder_follow_up(0, '2026-10-27', 5)"), /check constraint/);
        assert.equal((await pg.query('SELECT * FROM reminder_preferences')).rows.length, 0, 'failed preference updates roll back their default row');
      });
    } finally { await pg?.close(); }
  });
}
