import type {
  ConversationMessage,
  DailyTokenUsage,
  Fact,
  FactTier,
  NewConversationMessage,
  NewReminder,
  PendingActionRecord,
  Reminder,
  ReminderUpdate,
  TokenUsageRecord,
  TokenUsageSummary,
} from '../types/assistant.js';
import type { AssistantStore } from './assistant-store.js';
import { groupUsageByDay } from './token-usage.js';
import { defaultReminderPreferences, type ReminderOccurrence, type ReminderPreferences, type ReminderPreferencesPatch } from './reminder-action-store.js';
import { validateFollowUpBudget, validateFutureInstant, validateReminderOwner } from './reminder-store-validation.js';
import { validateReminderPreferences } from './reminder-policy.js';

/**
 * In-memory AssistantStore used by tests and as a safe fallback. State is
 * per-instance (never module-level) so tests cannot leak into each other.
 */
export class InMemoryAssistantStore implements AssistantStore {
  private messages: ConversationMessage[] = [];
  private facts = new Map<string, Fact>();
  private reminders: Reminder[] = [];
  private occurrences: ReminderOccurrence[] = [];
  private preferences = new Map<number, ReminderPreferences>();
  private followUpUsage = new Map<string, number>();
  private occurrenceId = 1;
  private pendingActions: PendingActionRecord[] = [];
  private tokenUsage: (TokenUsageRecord & { createdAt: string })[] = [];
  private messageId = 1;
  private reminderId = 1;
  private pendingId = 1;

  private factKey(userId: number, key: string): string {
    return `${userId}:${key.toLowerCase()}`;
  }

  async appendMessages(messages: NewConversationMessage[]): Promise<void> {
    for (const message of messages) {
      this.messages.push({
        id: this.messageId++,
        userId: message.userId,
        role: message.role,
        content: message.content,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async getRecentMessages(userId: number, limit: number): Promise<ConversationMessage[]> {
    const forUser = this.messages.filter((message) => message.userId === userId);
    return forUser.slice(-limit);
  }

  async countMessages(userId: number): Promise<number> {
    return this.messages.filter((message) => message.userId === userId).length;
  }

  async clearMessages(userId: number): Promise<void> {
    this.messages = this.messages.filter((message) => message.userId !== userId);
  }

  async saveFact(userId: number, key: string, value: string, tier: FactTier = 'reference'): Promise<void> {
    this.facts.set(this.factKey(userId, key), {
      key,
      value,
      tier,
      updatedAt: new Date().toISOString(),
    });
  }

  async getFact(userId: number, key: string): Promise<Fact | null> {
    return this.facts.get(this.factKey(userId, key)) ?? null;
  }

  async listFacts(userId: number, limit = 50): Promise<Fact[]> {
    const prefix = `${userId}:`;
    return [...this.facts.entries()]
      .filter(([storedKey]) => storedKey.startsWith(prefix))
      .map(([, fact]) => fact)
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  async listCoreFacts(userId: number, limit = 20): Promise<Fact[]> {
    const prefix = `${userId}:`;
    return [...this.facts.entries()]
      .filter(([storedKey]) => storedKey.startsWith(prefix))
      .map(([, fact]) => fact)
      .filter((fact) => (fact.tier ?? 'reference') === 'core')
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  async deleteFact(userId: number, key: string): Promise<boolean> {
    return this.facts.delete(this.factKey(userId, key));
  }

  async createReminder(reminder: NewReminder): Promise<Reminder> {
    const created: Reminder = {
      id: this.reminderId++,
      userId: reminder.userId,
      text: reminder.text,
      nextRunAt: reminder.nextRunAt,
      frequency: reminder.frequency,
      timeOfDay: reminder.timeOfDay ?? null,
      dayOfWeek: reminder.dayOfWeek ?? null,
      dayOfMonth: reminder.dayOfMonth ?? null,
      active: true,
      lastSentAt: null,
      createdAt: new Date().toISOString(),
    };
    this.reminders.push(created);
    return created;
  }

  async listReminders(userId: number, includeInactive = false): Promise<Reminder[]> {
    return this.reminders
      .filter((reminder) => reminder.userId === userId && (includeInactive || reminder.active))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async listDueReminders(now: Date, limit = 50, userId?: number): Promise<Reminder[]> {
    return structuredClone(this.reminders
      .filter((reminder) => reminder.active && (userId === undefined || reminder.userId === userId) && new Date(reminder.nextRunAt) <= now)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, limit));
  }

  async getReminder(id: number, userId: number): Promise<Reminder | null> {
    return this.reminders.find((reminder) => reminder.id === id && reminder.userId === userId && reminder.active) ?? null;
  }

  async updateReminder(id: number, userId: number, update: ReminderUpdate): Promise<Reminder | null> {
    const reminder = await this.getReminder(id, userId);
    if (!reminder) return null;
    reminder.text = update.text;
    if (update.schedule) {
      Object.assign(reminder, update.schedule, {
        timeOfDay: update.schedule.timeOfDay ?? null,
        dayOfWeek: update.schedule.dayOfWeek ?? null,
        dayOfMonth: update.schedule.dayOfMonth ?? null,
      });
    }
    return reminder;
  }

  private occurrenceMatches(reminder: Reminder, expected: Reminder): boolean {
    return reminder.active && (
      reminder.userId === expected.userId
      && new Date(reminder.nextRunAt).getTime() === new Date(expected.nextRunAt).getTime()
      && reminder.frequency === expected.frequency
      && reminder.timeOfDay === expected.timeOfDay
      && reminder.dayOfWeek === expected.dayOfWeek
      && reminder.dayOfMonth === expected.dayOfMonth
    );
  }

  async markReminderSent(id: number, nextRunAt: string, sentAt: string, expected: Reminder): Promise<void> {
    const reminder = this.reminders.find((candidate) => candidate.id === id);
    if (reminder && this.occurrenceMatches(reminder, expected)) {
      reminder.nextRunAt = nextRunAt;
      reminder.lastSentAt = sentAt;
    }
  }

  async completeReminder(id: number, sentAt: string, expected: Reminder): Promise<void> {
    const reminder = this.reminders.find((candidate) => candidate.id === id);
    if (reminder && this.occurrenceMatches(reminder, expected)) {
      reminder.active = false;
      reminder.lastSentAt = sentAt;
    }
  }

  async cancelReminder(id: number, userId: number): Promise<boolean> {
    const reminder = this.reminders.find((row) => row.id === id && row.userId === userId);
    if (!reminder) return false;
    let changed = reminder.active;
    reminder.active = false;
    for (const occurrence of this.occurrences) {
      if (occurrence.reminderId === id && occurrence.userId === userId && occurrence.status === 'pending') {
        Object.assign(occurrence, { status: 'cancelled', version: occurrence.version + 1, nextNotificationAt: null, leaseToken: null, leaseUntil: null });
        changed = true;
      }
    }
    return changed;
  }

  async materializeReminder(expected: Reminder, nextRunAt: string | null, now: Date): Promise<ReminderOccurrence | null> {
    validateReminderOwner(expected.userId);
    if (nextRunAt !== null) validateFutureInstant(nextRunAt, now);
    const reminder = this.reminders.find((row) => row.id === expected.id);
    if (!reminder || !this.occurrenceMatches(reminder, expected) || new Date(reminder.nextRunAt) > now) return null;
    if (reminder.frequency === 'once' && nextRunAt !== null) throw new Error('One-off reminders cannot recur.');
    if (this.occurrences.some((row) => row.reminderId === reminder.id && Date.parse(row.scheduledFor) === Date.parse(reminder.nextRunAt))) return null;
    const occurrence: ReminderOccurrence = {
      id: this.occurrenceId++, reminderId: reminder.id, userId: reminder.userId, text: reminder.text,
      scheduledFor: reminder.nextRunAt, status: 'pending', nextNotificationAt: reminder.nextRunAt,
      notificationKind: 'initial', lastNotifiedAt: null, notificationCount: 0, followUpCount: 0,
      completedAt: null, version: 0, leaseToken: null, leaseUntil: null,
    };
    this.occurrences.push(occurrence);
    if (nextRunAt === null) reminder.active = false;
    else reminder.nextRunAt = nextRunAt;
    return structuredClone(occurrence);
  }

  async listPendingReminderOccurrences(userId: number, limit = 100): Promise<ReminderOccurrence[]> {
    validateReminderOwner(userId);
    return structuredClone(this.occurrences.filter((row) => row.userId === userId && row.status === 'pending')
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor) || a.id - b.id).slice(0, limit));
  }

  async listDueReminderOccurrences(now: Date, limit = 50, userId?: number): Promise<ReminderOccurrence[]> {
    if (userId !== undefined) validateReminderOwner(userId);
    return structuredClone(this.occurrences.filter((row) => row.status === 'pending'
      && (userId === undefined || row.userId === userId) && row.nextNotificationAt !== null
      && Date.parse(row.nextNotificationAt) <= now.getTime()
      && (row.leaseUntil === null || Date.parse(row.leaseUntil) <= now.getTime()))
      .sort((a, b) => Date.parse(a.nextNotificationAt!) - Date.parse(b.nextNotificationAt!) || a.id - b.id).slice(0, limit));
  }

  async getReminderOccurrence(id: number, userId: number): Promise<ReminderOccurrence | null> {
    validateReminderOwner(userId);
    return structuredClone(this.occurrences.find((row) => row.id === id && row.userId === userId) ?? null);
  }

  async claimReminderOccurrence(id: number, version: number, now: Date, leaseUntil: Date, token: string): Promise<ReminderOccurrence | null> {
    validateFutureInstant(leaseUntil.toISOString(), now);
    if (!token) throw new Error('A delivery lease requires a token.');
    const row = this.occurrences.find((item) => item.id === id && item.version === version && item.status === 'pending');
    if (!row || row.nextNotificationAt === null || Date.parse(row.nextNotificationAt) > now.getTime()
      || (row.notificationKind === 'followup' && row.followUpCount >= 2)
      || (row.leaseUntil !== null && Date.parse(row.leaseUntil) > now.getTime())) return null;
    row.leaseToken = token;
    row.leaseUntil = leaseUntil.toISOString();
    return structuredClone(row);
  }

  async actOnReminderOccurrence(id: number, userId: number, version: number, action: 'done' | 'skip' | 'snooze', now: Date, snoozeUntil?: string): Promise<ReminderOccurrence | null> {
    validateReminderOwner(userId);
    if (!['done', 'skip', 'snooze'].includes(action)) throw new Error('Invalid reminder action.');
    if (action === 'snooze') validateFutureInstant(snoozeUntil ?? '', now);
    const row = this.occurrences.find((item) => item.id === id && item.userId === userId && item.version === version && item.status === 'pending');
    if (!row) return null;
    row.version++;
    row.leaseToken = row.leaseUntil = null;
    if (action === 'snooze') {
      row.nextNotificationAt = new Date(snoozeUntil!).toISOString();
      row.notificationKind = 'snooze';
    } else {
      row.status = action === 'done' ? 'done' : 'skipped';
      row.completedAt = now.toISOString();
      row.nextNotificationAt = null;
    }
    return structuredClone(row);
  }

  async finishReminderOccurrence(id: number, version: number, token: string, sentAt: Date, nextNotificationAt: string | null): Promise<boolean> {
    if (nextNotificationAt !== null) validateFutureInstant(nextNotificationAt, sentAt);
    const row = this.occurrences.find((item) => item.id === id && item.version === version && item.leaseToken === token && item.status === 'pending');
    if (!row) return false;
    row.notificationCount++;
    if (row.notificationKind === 'followup') row.followUpCount++;
    row.lastNotifiedAt = sentAt.toISOString();
    row.nextNotificationAt = this.preferences.get(row.userId)?.followUpsEnabled && row.followUpCount < 2 ? nextNotificationAt : null;
    row.notificationKind = 'followup';
    row.leaseToken = row.leaseUntil = null;
    const reminder = this.reminders.find((item) => item.id === row.reminderId);
    if (reminder && (!reminder.lastSentAt || Date.parse(reminder.lastSentAt) < sentAt.getTime())) reminder.lastSentAt = sentAt.toISOString();
    return true;
  }

  async deferReminderOccurrence(id: number, version: number, token: string, until: string | null): Promise<boolean> {
    if (until !== null && !Number.isFinite(Date.parse(until))) throw new Error('Invalid reminder time.');
    const row = this.occurrences.find((item) => item.id === id && item.version === version && item.leaseToken === token && item.status === 'pending');
    if (!row) return false;
    row.nextNotificationAt = row.notificationKind === 'followup' && !this.preferences.get(row.userId)?.followUpsEnabled ? null : until;
    row.leaseToken = row.leaseUntil = null;
    return true;
  }

  async getReminderPreferences(userId: number): Promise<ReminderPreferences> {
    validateReminderOwner(userId);
    return structuredClone(this.preferences.get(userId) ?? defaultReminderPreferences(userId));
  }

  async updateReminderPreferences(userId: number, patch: ReminderPreferencesPatch): Promise<ReminderPreferences> {
    validateReminderOwner(userId);
    const preferences = { ...(this.preferences.get(userId) ?? defaultReminderPreferences(userId)), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    validateReminderPreferences(preferences);
    this.preferences.set(userId, preferences);
    if (!preferences.followUpsEnabled) {
      for (const row of this.occurrences) {
        if (row.userId === userId && row.status === 'pending' && row.notificationKind === 'followup') {
          row.nextNotificationAt = row.leaseToken = row.leaseUntil = null;
        }
      }
    }
    return structuredClone(preferences);
  }

  async reserveReminderFollowUp(userId: number, localDate: string, maximum: number): Promise<boolean> {
    validateReminderOwner(userId);
    validateFollowUpBudget(localDate, maximum);
    const key = `${userId}:${localDate}`;
    const count = this.followUpUsage.get(key) ?? 0;
    if (count >= maximum) return false;
    this.followUpUsage.set(key, count + 1);
    return true;
  }

  async createPendingAction(
    action: Omit<PendingActionRecord, 'id' | 'createdAt'>
  ): Promise<PendingActionRecord> {
    const created: PendingActionRecord = {
      ...action,
      id: this.pendingId++,
      createdAt: new Date().toISOString(),
    };
    this.pendingActions.push(created);
    return created;
  }

  async getPendingAction(id: number, userId: number): Promise<PendingActionRecord | null> {
    return (
      this.pendingActions.find((action) => action.id === id && action.userId === userId) ?? null
    );
  }

  async consumePendingAction(id: number, userId: number): Promise<PendingActionRecord | null> {
    // No await between lookup/removal: mirrors a single DELETE RETURNING.
    const index = this.pendingActions.findIndex((action) => action.id === id && action.userId === userId);
    if (index === -1) return null;
    return this.pendingActions.splice(index, 1)[0];
  }

  async deletePendingAction(id: number): Promise<void> {
    this.pendingActions = this.pendingActions.filter((action) => action.id !== id);
  }

  async deleteExpiredPendingActions(now: Date): Promise<number> {
    const before = this.pendingActions.length;
    this.pendingActions = this.pendingActions.filter(
      (action) => new Date(action.expiresAt) > now
    );
    return before - this.pendingActions.length;
  }

  async recordTokenUsage(record: TokenUsageRecord): Promise<void> {
    this.tokenUsage.push({ ...record, createdAt: new Date().toISOString() });
  }

  async dailyTokenUsage(userId: number, days: number, timezone: string): Promise<DailyTokenUsage[]> {
    const sinceMs = Date.now() - days * 86_400_000;
    const rows = this.tokenUsage.filter(
      (row) => row.userId === userId && new Date(row.createdAt).getTime() >= sinceMs
    );

    return groupUsageByDay(
      rows.map((row) => ({
        createdAt: row.createdAt,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        cachedTokens: row.cachedTokens,
        systemTokens: row.systemTokens,
        toolsTokens: row.toolsTokens,
        messagesTokens: row.messagesTokens,
      })),
      timezone
    );
  }

  async summariseTokenUsage(userId: number, since: Date): Promise<TokenUsageSummary> {
    const sinceMs = since.getTime();
    const rows = this.tokenUsage.filter(
      (row) => row.userId === userId && new Date(row.createdAt).getTime() >= sinceMs
    );

    if (rows.length === 0) {
      return {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        averagePromptTokens: 0,
        firstRecordedAt: null,
        lastRecordedAt: null,
      };
    }

    const sum = (pick: (row: typeof rows[number]) => number) =>
      rows.reduce((total, row) => total + pick(row), 0);

    const promptTokens = sum((row) => row.promptTokens);
    const timestamps = rows.map((row) => row.createdAt).sort();

    return {
      calls: rows.length,
      promptTokens,
      completionTokens: sum((row) => row.completionTokens),
      totalTokens: sum((row) => row.totalTokens),
      cachedTokens: sum((row) => row.cachedTokens),
      averagePromptTokens: Math.round(promptTokens / rows.length),
      firstRecordedAt: timestamps[0],
      lastRecordedAt: timestamps[timestamps.length - 1],
    };
  }
}
