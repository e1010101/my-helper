import type {
  ConversationMessage,
  Fact,
  FactTier,
  NewConversationMessage,
  NewReminder,
  PendingActionRecord,
  Reminder,
} from '../types/assistant.js';
import type { AssistantStore } from './assistant-store.js';

/**
 * In-memory AssistantStore used by tests and as a safe fallback. State is
 * per-instance (never module-level) so tests cannot leak into each other.
 */
export class InMemoryAssistantStore implements AssistantStore {
  private messages: ConversationMessage[] = [];
  private facts = new Map<string, Fact>();
  private reminders: Reminder[] = [];
  private pendingActions: PendingActionRecord[] = [];
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

  async listDueReminders(now: Date, limit = 50): Promise<Reminder[]> {
    return this.reminders
      .filter((reminder) => reminder.active && new Date(reminder.nextRunAt) <= now)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, limit);
  }

  async markReminderSent(id: number, nextRunAt: string, sentAt: string): Promise<void> {
    const reminder = this.reminders.find((candidate) => candidate.id === id);
    if (reminder) {
      reminder.nextRunAt = nextRunAt;
      reminder.lastSentAt = sentAt;
    }
  }

  async completeReminder(id: number, sentAt: string): Promise<void> {
    const reminder = this.reminders.find((candidate) => candidate.id === id);
    if (reminder) {
      reminder.active = false;
      reminder.lastSentAt = sentAt;
    }
  }

  async cancelReminder(id: number, userId: number): Promise<boolean> {
    const index = this.reminders.findIndex(
      (reminder) => reminder.id === id && reminder.userId === userId && reminder.active
    );
    if (index === -1) {
      return false;
    }
    this.reminders[index].active = false;
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
}
