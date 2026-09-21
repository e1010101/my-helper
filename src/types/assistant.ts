/** Core data shapes for the assistant's persistent state. */

export type MessageRole = 'user' | 'model';

export interface ConversationMessage {
  id: number;
  userId: number;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface NewConversationMessage {
  userId: number;
  role: MessageRole;
  content: string;
}

/**
 * Facts are split by how they should be used.
 *
 * `core` facts are injected into every prompt, because the point of them is to
 * shape behaviour without being asked. `reference` facts are looked up only when
 * relevant, so they never cost prompt tokens.
 */
export type FactTier = 'core' | 'reference';

export interface Fact {
  key: string;
  value: string;
  updatedAt: string;
  /** Defaults to 'reference' when unset, matching the column default. */
  tier?: FactTier;
}

export interface ProfileEntry {
  key: string;
  value: string;
}

export type ReminderFrequency = 'once' | 'daily' | 'weekly' | 'monthly';

export interface Reminder {
  id: number;
  userId: number;
  text: string;
  /** When the reminder is next due, as an ISO timestamp. */
  nextRunAt: string;
  frequency: ReminderFrequency;
  /** Local wall-clock time of day, "HH:MM". Null for one-off reminders. */
  timeOfDay: string | null;
  /** 0=Sunday..6=Saturday. Only used when frequency is 'weekly'. */
  dayOfWeek: number | null;
  /** 1-31. Only used when frequency is 'monthly'. */
  dayOfMonth: number | null;
  active: boolean;
  lastSentAt: string | null;
  createdAt: string;
}

export interface NewReminder {
  userId: number;
  text: string;
  nextRunAt: string;
  frequency: ReminderFrequency;
  timeOfDay?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
}

export interface PendingActionRecord {
  id: number;
  userId: number;
  toolName: string;
  args: Record<string, unknown>;
  /** The model turn that requested the call, kept so the loop can resume. */
  modelParts: unknown[];
  createdAt: string;
  expiresAt: string;
}

/** One model call, as recorded for later reporting. */
export interface TokenUsageRecord {
  userId: number;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** Shares of promptTokens, so the three sum to the prompt total. */
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  iteration: number;
}

/** Aggregate over a window, for the /memory summary. */
export interface TokenUsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** Mean prompt size — the number that reveals slow growth. */
  averagePromptTokens: number;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
}
