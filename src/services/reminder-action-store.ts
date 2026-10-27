import type { Reminder } from '../types/assistant.js';

export type ReminderOccurrenceStatus = 'pending' | 'done' | 'skipped' | 'cancelled';
export type ReminderNotificationKind = 'initial' | 'snooze' | 'followup';

/** A scheduled occurrence is independent of its recurring series. */
export interface ReminderOccurrence {
  id: number;
  reminderId: number;
  userId: number;
  text: string;
  scheduledFor: string;
  status: ReminderOccurrenceStatus;
  nextNotificationAt: string | null;
  notificationKind: ReminderNotificationKind;
  lastNotifiedAt: string | null;
  notificationCount: number;
  followUpCount: number;
  completedAt: string | null;
  /** Incremented by user actions/cancellation, not by delivery bookkeeping. */
  version: number;
  leaseToken: string | null;
  leaseUntil: string | null;
}

export interface ReminderPreferences {
  userId: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  followUpsEnabled: boolean;
}

export type ReminderPreferencesPatch = Partial<Omit<ReminderPreferences, 'userId'>>;

export const FOLLOW_UP_DELAY_MINUTES = 60;
export const MAX_FOLLOW_UPS_PER_OCCURRENCE = 2;
export const MAX_FOLLOW_UP_ATTEMPTS_PER_DAY = 5;

export function defaultReminderPreferences(userId: number): ReminderPreferences {
  return { userId, quietHoursStart: null, quietHoursEnd: null, followUpsEnabled: false };
}

/** Atomic operations shared by the scheduler, Telegram callbacks and both stores. */
export interface ReminderActionStore {
  /** CAS the series, create its unique occurrence, and advance/deactivate it in one transaction. */
  materializeReminder(reminder: Reminder, nextRunAt: string | null, now: Date): Promise<ReminderOccurrence | null>;
  listPendingReminderOccurrences(userId: number, limit?: number): Promise<ReminderOccurrence[]>;
  listDueReminderOccurrences(now: Date, limit?: number, userId?: number): Promise<ReminderOccurrence[]>;
  getReminderOccurrence(id: number, userId: number): Promise<ReminderOccurrence | null>;
  /** Only an unclaimed/expired, due, pending occurrence with this version can be claimed. */
  claimReminderOccurrence(id: number, version: number, now: Date, leaseUntil: Date, token: string): Promise<ReminderOccurrence | null>;
  /** A versioned action invalidates any outstanding delivery lease. */
  actOnReminderOccurrence(id: number, userId: number, version: number, action: 'done' | 'skip' | 'snooze', now: Date, snoozeUntil?: string): Promise<ReminderOccurrence | null>;
  /** Returns false if a user action/cancellation has superseded the in-flight send. */
  finishReminderOccurrence(id: number, version: number, token: string, sentAt: Date, nextNotificationAt: string | null): Promise<boolean>;
  /** Clear the lease and defer a send (or stop automatic sends with null). */
  deferReminderOccurrence(id: number, version: number, token: string, until: string | null): Promise<boolean>;
  getReminderPreferences(userId: number): Promise<ReminderPreferences>;
  /** Turning follow-ups off also clears pending follow-up sends and their leases. */
  updateReminderPreferences(userId: number, patch: ReminderPreferencesPatch): Promise<ReminderPreferences>;
  /** Atomic per-user local-day budget; failed send attempts consume budget too. */
  reserveReminderFollowUp(userId: number, localDate: string, maximum: number): Promise<boolean>;
}
