import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from './database.js';
import type { AssistantStore } from './assistant-store.js';
import type {
  ConversationMessage,
  Fact,
  FactTier,
  NewConversationMessage,
  NewReminder,
  PendingActionRecord,
  Reminder,
  ReminderFrequency,
  TokenUsageRecord,
  TokenUsageSummary,
} from '../types/assistant.js';

/**
 * Upper bound on rows read for a usage summary. A month of heavy use is well
 * under this; the cap exists so a pathological window cannot pull unbounded
 * data into memory.
 */
const MAX_USAGE_ROWS = 5000;

interface MessageRow {
  id: number;
  user_id: number;
  role: string;
  content: string;
  created_at: string;
}

interface FactRow {
  key: string;
  value: string;
  tier?: string | null;
  updated_at: string;
}

interface ReminderRow {
  id: number;
  user_id: number;
  text: string;
  next_run_at: string;
  frequency: string;
  time_of_day: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  active: boolean;
  last_sent_at: string | null;
  created_at: string;
}

interface PendingActionRow {
  id: number;
  user_id: number;
  tool_name: string;
  args: unknown;
  model_parts: unknown;
  created_at: string;
  expires_at: string;
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role === 'model' ? 'model' : 'user',
    content: row.content,
    createdAt: row.created_at,
  };
}

function toFact(row: FactRow): Fact {
  // Anything that is not explicitly 'core' is treated as reference, so a
  // database predating the tier column behaves like the safest default.
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
    tier: row.tier === 'core' ? 'core' : 'reference',
  };
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userId: row.user_id,
    text: row.text,
    nextRunAt: row.next_run_at,
    frequency: row.frequency as ReminderFrequency,
    timeOfDay: row.time_of_day,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    active: row.active,
    lastSentAt: row.last_sent_at,
    createdAt: row.created_at,
  };
}

/**
 * Postgres-backed assistant state. Uses the shared DatabaseService client,
 * which must be configured with the service_role key because these tables have
 * Row Level Security enabled with no public policies.
 */
export class SupabaseAssistantStore implements AssistantStore {
  private client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? db.getClient();
  }

  async appendMessages(messages: NewConversationMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const { error } = await this.client.from('conversations').insert(
      messages.map((message) => ({
        user_id: message.userId,
        role: message.role,
        content: message.content,
      }))
    );

    if (error) {
      throw new Error(`Failed to append conversation messages: ${error.message}`);
    }
  }

  async getRecentMessages(userId: number, limit: number): Promise<ConversationMessage[]> {
    const { data, error } = await this.client
      .from('conversations')
      .select('id, user_id, role, content, created_at')
      .eq('user_id', userId)
      .order('id', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to load conversation history: ${error.message}`);
    }

    // Fetched newest-first for the limit, returned oldest-first for replay.
    return (data as MessageRow[]).map(toMessage).reverse();
  }

  async countMessages(userId: number): Promise<number> {
    const { count, error } = await this.client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to count conversation messages: ${error.message}`);
    }

    return count ?? 0;
  }

  async clearMessages(userId: number): Promise<void> {
    const { error } = await this.client.from('conversations').delete().eq('user_id', userId);
    if (error) {
      throw new Error(`Failed to clear conversation history: ${error.message}`);
    }
  }

  async saveFact(userId: number, key: string, value: string, tier: FactTier = 'reference'): Promise<void> {
    const { error } = await this.client.from('facts').upsert(
      {
        user_id: userId,
        key: key.toLowerCase(),
        value,
        tier,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,key' }
    );

    if (error) {
      throw new Error(`Failed to save fact: ${error.message}`);
    }
  }

  async getFact(userId: number, key: string): Promise<Fact | null> {
    const { data, error } = await this.client
      .from('facts')
      .select('key, value, tier, updated_at')
      .eq('user_id', userId)
      .eq('key', key.toLowerCase())
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load fact: ${error.message}`);
    }

    return data ? toFact(data as FactRow) : null;
  }

  async listFacts(userId: number, limit = 50): Promise<Fact[]> {
    const { data, error } = await this.client
      .from('facts')
      .select('key, value, tier, updated_at')
      .eq('user_id', userId)
      .order('key', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list facts: ${error.message}`);
    }

    return (data as FactRow[]).map(toFact);
  }

  /**
   * Core facts only, which are the ones injected into every prompt. Kept
   * separate from listFacts so the prompt path cannot accidentally pull in
   * reference material and inflate every request.
   */
  async listCoreFacts(userId: number, limit = 20): Promise<Fact[]> {
    const { data, error } = await this.client
      .from('facts')
      .select('key, value, tier, updated_at')
      .eq('user_id', userId)
      .eq('tier', 'core')
      .order('key', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list core facts: ${error.message}`);
    }

    return (data as FactRow[]).map(toFact);
  }

  async deleteFact(userId: number, key: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('facts')
      .delete()
      .eq('user_id', userId)
      .eq('key', key.toLowerCase())
      .select('key');

    if (error) {
      throw new Error(`Failed to delete fact: ${error.message}`);
    }

    return (data?.length ?? 0) > 0;
  }

  async createReminder(reminder: NewReminder): Promise<Reminder> {
    const { data, error } = await this.client
      .from('reminders')
      .insert({
        user_id: reminder.userId,
        text: reminder.text,
        next_run_at: reminder.nextRunAt,
        frequency: reminder.frequency,
        time_of_day: reminder.timeOfDay ?? null,
        day_of_week: reminder.dayOfWeek ?? null,
        day_of_month: reminder.dayOfMonth ?? null,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to create reminder: ${error.message}`);
    }

    return toReminder(data as ReminderRow);
  }

  async listReminders(userId: number, includeInactive = false): Promise<Reminder[]> {
    let query = this.client
      .from('reminders')
      .select('*')
      .eq('user_id', userId);

    if (!includeInactive) {
      query = query.eq('active', true);
    }

    const { data, error } = await query.order('next_run_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to list reminders: ${error.message}`);
    }

    return (data as ReminderRow[]).map(toReminder);
  }

  async listDueReminders(now: Date, limit = 50): Promise<Reminder[]> {
    const { data, error } = await this.client
      .from('reminders')
      .select('*')
      .eq('active', true)
      .lte('next_run_at', now.toISOString())
      .order('next_run_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to load due reminders: ${error.message}`);
    }

    return (data as ReminderRow[]).map(toReminder);
  }

  async markReminderSent(id: number, nextRunAt: string, sentAt: string): Promise<void> {
    const { error } = await this.client
      .from('reminders')
      .update({ next_run_at: nextRunAt, last_sent_at: sentAt })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to record reminder delivery: ${error.message}`);
    }
  }

  async completeReminder(id: number, sentAt: string): Promise<void> {
    const { error } = await this.client
      .from('reminders')
      .update({ active: false, last_sent_at: sentAt })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to complete reminder: ${error.message}`);
    }
  }

  async cancelReminder(id: number, userId: number): Promise<boolean> {
    const { data, error } = await this.client
      .from('reminders')
      .update({ active: false })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('active', true)
      .select('id');

    if (error) {
      throw new Error(`Failed to cancel reminder: ${error.message}`);
    }

    return (data?.length ?? 0) > 0;
  }

  async createPendingAction(
    action: Omit<PendingActionRecord, 'id' | 'createdAt'>
  ): Promise<PendingActionRecord> {
    const { data, error } = await this.client
      .from('pending_actions')
      .insert({
        user_id: action.userId,
        tool_name: action.toolName,
        args: action.args,
        model_parts: action.modelParts,
        expires_at: action.expiresAt,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to store pending action: ${error.message}`);
    }

    const row = data as PendingActionRow;
    return {
      id: row.id,
      userId: row.user_id,
      toolName: row.tool_name,
      args: (row.args ?? {}) as Record<string, unknown>,
      modelParts: (row.model_parts ?? []) as unknown[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async getPendingAction(id: number, userId: number): Promise<PendingActionRecord | null> {
    const { data, error } = await this.client
      .from('pending_actions')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load pending action: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    const row = data as PendingActionRow;
    return {
      id: row.id,
      userId: row.user_id,
      toolName: row.tool_name,
      args: (row.args ?? {}) as Record<string, unknown>,
      modelParts: (row.model_parts ?? []) as unknown[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deletePendingAction(id: number): Promise<void> {
    const { error } = await this.client.from('pending_actions').delete().eq('id', id);
    if (error) {
      throw new Error(`Failed to delete pending action: ${error.message}`);
    }
  }

  async deleteExpiredPendingActions(now: Date): Promise<number> {
    const { data, error } = await this.client
      .from('pending_actions')
      .delete()
      .lt('expires_at', now.toISOString())
      .select('id');

    if (error) {
      throw new Error(`Failed to prune pending actions: ${error.message}`);
    }

    return data?.length ?? 0;
  }

  async recordTokenUsage(record: TokenUsageRecord): Promise<void> {
    const { error } = await this.client.from('token_usage').insert({
      user_id: record.userId,
      provider: record.provider,
      model: record.model,
      prompt_tokens: record.promptTokens,
      completion_tokens: record.completionTokens,
      total_tokens: record.totalTokens,
      cached_tokens: record.cachedTokens,
      system_tokens: record.systemTokens,
      tools_tokens: record.toolsTokens,
      messages_tokens: record.messagesTokens,
      iteration: record.iteration,
    });

    if (error) {
      throw new Error(`Failed to record token usage: ${error.message}`);
    }
  }

  /**
   * Aggregates in the database rather than fetching rows: this table grows by
   * one row per model call, so pulling a window into memory would get slower
   * every month. PostgREST exposes no aggregate functions, so the window is
   * fetched column-limited and summed here — bounded by the window rather than
   * by total history.
   */
  async summariseTokenUsage(userId: number, since: Date): Promise<TokenUsageSummary> {
    const { data, error } = await this.client
      .from('token_usage')
      .select('prompt_tokens, completion_tokens, total_tokens, cached_tokens, created_at')
      .eq('user_id', userId)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(MAX_USAGE_ROWS);

    if (error) {
      throw new Error(`Failed to summarise token usage: ${error.message}`);
    }

    const rows = (data ?? []) as {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cached_tokens: number;
      created_at: string;
    }[];

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

    const sum = (pick: (row: (typeof rows)[number]) => number) =>
      rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

    const promptTokens = sum((row) => row.prompt_tokens);

    return {
      calls: rows.length,
      promptTokens,
      completionTokens: sum((row) => row.completion_tokens),
      totalTokens: sum((row) => row.total_tokens),
      cachedTokens: sum((row) => row.cached_tokens),
      averagePromptTokens: Math.round(promptTokens / rows.length),
      firstRecordedAt: rows[0].created_at,
      lastRecordedAt: rows[rows.length - 1].created_at,
    };
  }
}
