import { logger } from './logger.js';
import type { Clock } from './assistant-store.js';
import { nextOccurrence } from './reminder-time.js';
import type { Reminder } from '../types/assistant.js';

export interface ReminderDelivery {
  reminder: Reminder;
  /** Wall-clock time when the poll noticed the reminder was due. */
  sentAt: Date;
  /** True when the reminder was missed while the bot was offline. */
  late: boolean;
}

export interface ReminderSchedulerOptions {
  store: {
    listDueReminders(now: Date, limit?: number): Promise<Reminder[]>;
    markReminderSent(id: number, nextRunAt: string, sentAt: string): Promise<void>;
    completeReminder(id: number, sentAt: string): Promise<void>;
  };
  /** How a due reminder reaches the user. Typically Telegram sendMessage. */
  deliver: (delivery: ReminderDelivery) => Promise<void>;
  timezone: string;
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

/**
 * Polls for due reminders and delivers them.
 *
 * Delivery is at-least-once by design: if the process dies between delivering
 * and recording, the user may see a duplicate, which is far preferable to
 * silence. Recording the delivery in the same step as the reschedule is what
 * keeps that window as small as possible.
 */
export class ReminderScheduler {
  private readonly store: ReminderSchedulerOptions['store'];
  private readonly deliver: ReminderSchedulerOptions['deliver'];
  private readonly timezone: string;
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
   * Returns the reminders that were delivered.
   */
  async tick(): Promise<Reminder[]> {
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

      const due = await this.store.listDueReminders(now, MAX_DELIVERIES_PER_TICK);
      const delivered: Reminder[] = [];

      for (const reminder of due) {
        try {
          await this.deliverOnce(reminder, now);
          delivered.push(reminder);
        } catch (error) {
          // One bad reminder (deleted chat, blocked bot, scheduling bug) must
          // not stop the rest or kill the loop.
          logger.error(`Failed to deliver reminder ${reminder.id}`, error);
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

  private async deliverOnce(reminder: Reminder, now: Date): Promise<void> {
    const dueAt = new Date(reminder.nextRunAt);
    const late = now.getTime() - dueAt.getTime() > this.latenessThresholdMs;

    await this.deliver({ reminder, sentAt: now, late });

    // Only record the delivery after it reached the user.
    const sentAtIso = now.toISOString();

    if (reminder.frequency === 'once') {
      await this.store.completeReminder(reminder.id, sentAtIso);
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
      await this.store.completeReminder(reminder.id, sentAtIso);
      return;
    }

    await this.store.markReminderSent(reminder.id, follow.toISOString(), sentAtIso);
  }

  /** Number of scheduled reminders waiting to be delivered prematurely. */
  isRunning(): boolean {
    return this.running;
  }
}
