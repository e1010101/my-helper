import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import type { Clock } from './assistant-store.js';
import { nextOccurrence } from './reminder-time.js';
import type { Reminder } from '../types/assistant.js';
import {
  FOLLOW_UP_DELAY_MINUTES,
  MAX_FOLLOW_UPS_PER_OCCURRENCE,
  MAX_FOLLOW_UP_ATTEMPTS_PER_DAY,
  type ReminderActionStore,
  type ReminderOccurrence,
} from './reminder-action-store.js';
import { quietHoursEnd, nextLocalDay } from './reminder-policy.js';
import { localDateKey } from './token-usage.js';

export interface ReminderDelivery {
  occurrence: ReminderOccurrence;
  /** Wall-clock time when delivery started. */
  sentAt: Date;
  /** True when the reminder was missed while the bot was offline. */
  late: boolean;
}

export interface ReminderSchedulerOptions {
  store: Pick<ReminderActionStore,
    'materializeReminder' | 'listDueReminderOccurrences' | 'getReminderOccurrence' |
    'claimReminderOccurrence' | 'finishReminderOccurrence' | 'deferReminderOccurrence' |
    'getReminderPreferences' | 'reserveReminderFollowUp'> & {
    listDueReminders(now: Date, limit?: number, userId?: number): Promise<Reminder[]>;
  };
  /** How a due reminder reaches the user. Typically Telegram sendMessage. */
  deliver: (delivery: ReminderDelivery) => Promise<void>;
  timezone: string;
  /** Restrict materialization and delivery to the configured bot owner. */
  userId?: number;
  intervalMs?: number;
  clock?: Clock;
  /** A reminder more than this far past due is considered missed. */
  latenessThresholdMs?: number;
  /**
   * Housekeeping run once per poll. Used to prune expired confirmations so the
   * scheduler is the single periodic heartbeat of the process. Any return value
   * is discarded.
   */
  onPoll?: () => unknown;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LATENESS_THRESHOLD_MS = 60_000;
/** Safety valve so a scheduling bug cannot loop forever. */
const MAX_DELIVERIES_PER_TICK = 20;
const DELIVERY_LEASE_MS = 60_000;
const RETRY_DELAY_MS = 30_000;

/**
 * Materializes due series, then leases and delivers their independent occurrences.
 *
 * Delivery is at-least-once by design: if the process dies between delivering
 * and recording, the user may see a duplicate, which is far preferable to
 * silence. A durable lease prevents simultaneous workers from sending the same
 * occurrence. User actions invalidate that lease so delivery cannot undo them.
 */
export class ReminderScheduler {
  private readonly store: ReminderSchedulerOptions['store'];
  private readonly deliver: ReminderSchedulerOptions['deliver'];
  private readonly timezone: string;
  private readonly userId?: number;
  private readonly intervalMs: number;
  private readonly clock: Clock;
  private readonly latenessThresholdMs: number;
  private readonly onPoll?: () => unknown;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private ticking = false;

  constructor(options: ReminderSchedulerOptions) {
    this.store = options.store;
    this.deliver = options.deliver;
    this.timezone = options.timezone;
    this.userId = options.userId;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = options.clock ?? { now: () => new Date() };
    this.latenessThresholdMs = options.latenessThresholdMs ?? DEFAULT_LATENESS_THRESHOLD_MS;
    this.onPoll = options.onPoll;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Do not hold the event loop open purely for reminders.
    this.timer.unref?.();

    logger.info('Reminder scheduler started', { intervalMs: this.intervalMs, timezone: this.timezone });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
  }

  /**
   * Runs one poll. Exposed so tests can drive the scheduler without timers.
   * Returns the occurrences whose notifications reached the delivery adapter.
   */
  async tick(): Promise<ReminderOccurrence[]> {
    if (this.ticking) {
      return [];
    }
    this.ticking = true;

    try {
      const now = this.clock.now();

      // Housekeeping must never block or break delivery.
      if (this.onPoll) {
        try {
          await this.onPoll();
        } catch (error) {
          logger.error('Scheduler housekeeping failed', error);
        }
      }

      // Advancing a recurring series must not depend on resolving yesterday's
      // occurrence, or on Telegram being available at the scheduled time.
      try {
        const due = await this.store.listDueReminders(now, MAX_DELIVERIES_PER_TICK, this.userId);
        for (const reminder of due) {
          if (this.userId !== undefined && reminder.userId !== this.userId) continue;
          try {
            await this.materialize(reminder, now);
          } catch (error) {
            logger.error(`Failed to materialize reminder ${reminder.id}`, error);
          }
        }
      } catch (error) {
        logger.error('Failed to poll reminder schedules', error);
      }

      const due = await this.store.listDueReminderOccurrences(now, MAX_DELIVERIES_PER_TICK, this.userId);
      const delivered: ReminderOccurrence[] = [];
      for (const occurrence of due) {
        if (this.userId !== undefined && occurrence.userId !== this.userId) continue;
        try {
          if (await this.deliverOnce(occurrence)) delivered.push(occurrence);
        } catch (error) {
          logger.error(`Failed to deliver reminder occurrence ${occurrence.id}`, error);
        }
      }

      return delivered;
    } catch (error) {
      logger.error('Reminder poll failed', error);
      return [];
    } finally {
      this.ticking = false;
    }
  }

  private async materialize(reminder: Reminder, now: Date): Promise<void> {
    if (reminder.frequency === 'once') {
      await this.store.materializeReminder(reminder, null, now);
      return;
    }

    const follow = nextOccurrence(
      {
        timeOfDay: reminder.timeOfDay ?? '09:00',
        dayOfWeek: reminder.dayOfWeek,
        dayOfMonth: reminder.dayOfMonth,
      },
      now,
      this.timezone
    );

    if (!follow) {
      logger.warn(
        `Reminder ${reminder.id} has no future occurrence and was deactivated`,
        { frequency: reminder.frequency, timeOfDay: reminder.timeOfDay }
      );
    }
    await this.store.materializeReminder(reminder, follow?.toISOString() ?? null, now);
  }

  private async deliverOnce(candidate: ReminderOccurrence): Promise<boolean> {
    const now = this.clock.now();
    const token = randomUUID();
    const occurrence = await this.store.claimReminderOccurrence(
      candidate.id, candidate.version, now, new Date(now.getTime() + DELIVERY_LEASE_MS), token
    );
    if (!occurrence) return false;

    try {
      const preferences = await this.store.getReminderPreferences(occurrence.userId);
      const currentTime = this.clock.now();
      const automaticFollowUp = occurrence.notificationKind === 'followup';
      if (automaticFollowUp && (!preferences.followUpsEnabled || occurrence.followUpCount >= MAX_FOLLOW_UPS_PER_OCCURRENCE)) {
        await this.store.deferReminderOccurrence(occurrence.id, occurrence.version, token, null);
        return false;
      }

      const quietUntil = quietHoursEnd(currentTime, preferences, this.timezone);
      if (quietUntil) {
        await this.store.deferReminderOccurrence(occurrence.id, occurrence.version, token, quietUntil.toISOString());
        return false;
      }

      if (automaticFollowUp && !await this.store.reserveReminderFollowUp(
        occurrence.userId, localDateKey(currentTime, this.timezone), MAX_FOLLOW_UP_ATTEMPTS_PER_DAY
      )) {
        await this.store.deferReminderOccurrence(
          occurrence.id, occurrence.version, token, nextLocalDay(currentTime, this.timezone).toISOString()
        );
        return false;
      }

      // Preferences, budgets and other I/O may have allowed a callback or another
      // worker to change the occurrence. Check the lease immediately before send.
      const current = await this.store.getReminderOccurrence(occurrence.id, occurrence.userId);
      const sentAt = this.clock.now();
      if (!current || current.status !== 'pending' || current.version !== occurrence.version ||
          current.leaseToken !== token || !current.leaseUntil || new Date(current.leaseUntil).getTime() <= sentAt.getTime()) {
        return false;
      }

      // The final store read can cross a quiet-hour or local-day boundary.
      // Apply policy to the actual send time, not the earlier claim time.
      const quietAtSend = quietHoursEnd(sentAt, preferences, this.timezone);
      if (quietAtSend) {
        await this.store.deferReminderOccurrence(occurrence.id, occurrence.version, token, quietAtSend.toISOString());
        return false;
      }
      if (automaticFollowUp && localDateKey(sentAt, this.timezone) !== localDateKey(currentTime, this.timezone)) {
        // Keep the old reservation conservatively, release the lease, and let
        // the next poll reserve against today's budget before attempting I/O.
        await this.store.deferReminderOccurrence(occurrence.id, occurrence.version, token, sentAt.toISOString());
        return false;
      }

      const dueAt = new Date(occurrence.nextNotificationAt ?? occurrence.scheduledFor);
      const late = sentAt.getTime() - dueAt.getTime() > this.latenessThresholdMs;
      await this.deliver({ occurrence: current, sentAt, late });

      const updatedPreferences = await this.store.getReminderPreferences(occurrence.userId);
      const followUpCount = occurrence.followUpCount + (automaticFollowUp ? 1 : 0);
      const finishedAt = this.clock.now();
      const nextNotificationAt = updatedPreferences.followUpsEnabled && followUpCount < MAX_FOLLOW_UPS_PER_OCCURRENCE
        ? new Date(finishedAt.getTime() + FOLLOW_UP_DELAY_MINUTES * 60_000).toISOString()
        : null;
      await this.store.finishReminderOccurrence(occurrence.id, occurrence.version, token, finishedAt, nextNotificationAt);
      return true;
    } catch (error) {
      // The occurrence survives even when its one-off series has already been
      // deactivated. A failed send can therefore be retried after a restart.
      const until = new Date(this.clock.now().getTime() + retryDelay(error));
      await this.store.deferReminderOccurrence(occurrence.id, occurrence.version, token, until.toISOString());
      throw error;
    }
  }

  /** Whether periodic polling is enabled. */
  isRunning(): boolean {
    return this.running;
  }
}

function retryDelay(error: unknown): number {
  const response = (error as { response?: { error_code?: number; parameters?: { retry_after?: number } } } | null)?.response;
  const retryAfter = response?.parameters?.retry_after;
  if (response?.error_code === 429 && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.max(RETRY_DELAY_MS, retryAfter * 1000);
  }
  return RETRY_DELAY_MS;
}
