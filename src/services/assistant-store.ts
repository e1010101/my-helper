import type {
  ConversationMessage,
  Fact,
  FactTier,
  NewConversationMessage,
  NewReminder,
  PendingActionRecord,
  Reminder,
} from '../types/assistant.js';

/**
 * Everything the assistant needs to persist. The interface exists so the
 * scheduler, tool registry and AI loop can be exercised in tests against an
 * in-memory implementation instead of a live database.
 */
export interface AssistantStore {
  // --- Conversation memory ---
  appendMessages(messages: NewConversationMessage[]): Promise<void>;
  /** Most recent messages, returned oldest-first and capped at `limit`. */
  getRecentMessages(userId: number, limit: number): Promise<ConversationMessage[]>;
  countMessages(userId: number): Promise<number>;
  clearMessages(userId: number): Promise<void>;

  // --- Long-lived facts / preferences ---
  saveFact(userId: number, key: string, value: string, tier?: FactTier): Promise<void>;
  getFact(userId: number, key: string): Promise<Fact | null>;
  listFacts(userId: number, limit?: number): Promise<Fact[]>;
  /**
   * Only the facts that belong in every prompt, ordered core-first. Added
   * alongside listFacts rather than changing it: this interface has many
   * consumers, and widening an existing signature risks all of them.
   */
  listCoreFacts(userId: number, limit?: number): Promise<Fact[]>;
  deleteFact(userId: number, key: string): Promise<boolean>;

  // --- Reminders ---
  createReminder(reminder: NewReminder): Promise<Reminder>;
  listReminders(userId: number, includeInactive?: boolean): Promise<Reminder[]>;
  /** Reminders whose next run is at or before `now`, oldest first. */
  listDueReminders(now: Date, limit?: number): Promise<Reminder[]>;
  /**
   * Records a delivery: sets the next run time and stamps last_sent_at in one
   * step so a reminder can never be sent twice for the same occurrence.
   */
  markReminderSent(id: number, nextRunAt: string, sentAt: string): Promise<void>;
  completeReminder(id: number, sentAt: string): Promise<void>;
  cancelReminder(id: number, userId: number): Promise<boolean>;

  // --- Pending confirmations ---
  createPendingAction(action: Omit<PendingActionRecord, 'id' | 'createdAt'>): Promise<PendingActionRecord>;
  getPendingAction(id: number, userId: number): Promise<PendingActionRecord | null>;
  deletePendingAction(id: number): Promise<void>;
  deleteExpiredPendingActions(now: Date): Promise<number>;
}

/** Replaceable clock so time-dependent behaviour can be tested deterministically. */
export interface Clock {
  now(): Date;
}
