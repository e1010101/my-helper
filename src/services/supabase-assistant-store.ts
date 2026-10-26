import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from './database.js';
import { localDateKey } from './token-usage.js';
import type { AssistantStore } from './assistant-store.js';
import type {
  ConversationMessage,
  DailyTokenUsage,
  Fact,
  FactTier,
  NewConversationMessage,
  NewReminder,
  PendingActionRecord,
  Reminder,
  ReminderFrequency,
  ReminderUpdate,
  TokenUsageRecord,
  TokenUsageSummary,
} from '../types/assistant.js';

/** Page size only: reports keep reading until the captured window is exhausted. */
const USAGE_PAGE_SIZE = 1000;

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
  requested_at?: string | null;
  created_at: string;
  expires_at: string;
}

interface UsageRow {
  id: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  system_tokens: number;
  tools_tokens: number;
  messages_tokens: number;
  created_at: string;
}

function toPendingAction(row: PendingActionRow): PendingActionRecord {
  return {
    id: row.id, userId: row.user_id, toolName: row.tool_name,
    args: (row.args ?? {}) as Record<string, unknown>,
    modelParts: (row.model_parts ?? []) as unknown[],
    requestedAt: row.requested_at ?? row.created_at,
    createdAt: row.created_at, expiresAt: row.expires_at,
  };
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

  async getReminder(id: number, userId: number): Promise<Reminder | null> {
    const { data, error } = await this.client.from('reminders').select('*')
      .eq('id', id).eq('user_id', userId).eq('active', true).maybeSingle();
    if (error) throw new Error(`Failed to read reminder: ${error.message}`);
    return data ? toReminder(data as ReminderRow) : null;
  }

  async updateReminder(id: number, userId: number, update: ReminderUpdate): Promise<Reminder | null> {
    // Do not write a stale next_run_at back after a text-only edit: the
    // scheduler may have advanced it since the user opened the form.
    const patch = {
      text: update.text,
      ...(update.schedule ? {
        next_run_at: update.schedule.nextRunAt,
        frequency: update.schedule.frequency,
        time_of_day: update.schedule.timeOfDay ?? null,
        day_of_week: update.schedule.dayOfWeek ?? null,
        day_of_month: update.schedule.dayOfMonth ?? null,
      } : {}),
    };
    const { data, error } = await this.client.from('reminders').update(patch)
      .eq('id', id).eq('user_id', userId).eq('active', true).select('*').maybeSingle();
    if (error) throw new Error(`Failed to update reminder: ${error.message}`);
    return data ? toReminder(data as ReminderRow) : null;
  }

  private async updateDeliveredOccurrence(id: number, patch: Record<string, unknown>, expected: Reminder): Promise<void> {
    let query = this.client.from('reminders').update(patch).eq('id', id).eq('active', true);
    query = query.eq('user_id', expected.userId).eq('next_run_at', expected.nextRunAt)
      .eq('frequency', expected.frequency);
    for (const [column, value] of [
      ['time_of_day', expected.timeOfDay], ['day_of_week', expected.dayOfWeek], ['day_of_month', expected.dayOfMonth],
    ] as const) {
      query = value === null ? query.is(column, null) : query.eq(column, value);
    }
    const { error } = await query;
    if (error) throw new Error(`Failed to record reminder delivery: ${error.message}`);
  }

  async markReminderSent(id: number, nextRunAt: string, sentAt: string, expected: Reminder): Promise<void> {
    await this.updateDeliveredOccurrence(id, { next_run_at: nextRunAt, last_sent_at: sentAt }, expected);
  }

  async completeReminder(id: number, sentAt: string, expected: Reminder): Promise<void> {
    await this.updateDeliveredOccurrence(id, { active: false, last_sent_at: sentAt }, expected);
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
        requested_at: action.requestedAt ?? new Date().toISOString(),
        expires_at: action.expiresAt,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to store pending action: ${error.message}`);
    }

    return toPendingAction(data as PendingActionRow);
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

    return toPendingAction(data as PendingActionRow);
  }

  async consumePendingAction(id: number, userId: number): Promise<PendingActionRecord | null> {
    // PostgreSQL row locking makes DELETE RETURNING a one-winner claim even
    // when two application instances handle the same confirmation at once.
    const { data, error } = await this.client.from('pending_actions').delete()
      .eq('id', id).eq('user_id', userId).select('*').maybeSingle();
    if (error) throw new Error(`Failed to claim pending action: ${error.message}`);
    return data ? toPendingAction(data as PendingActionRow) : null;
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
   * Read a stable ID-bounded snapshot in keyset pages. A server can return fewer
   * rows than requested; only an empty page or reaching the captured maximum
   * ends the report. New calls cannot make a long report chase a moving tail.
   */
  private async *usagePages(userId: number, since: Date): AsyncGenerator<UsageRow[]> {
    const { data: newest, error: newestError } = await this.client.from('token_usage')
      .select('id').eq('user_id', userId).gte('created_at', since.toISOString())
      .order('id', { ascending: false }).limit(1).maybeSingle();
    if (newestError) throw new Error(`Failed to load token usage: ${newestError.message}`);
    if (!newest) return;
    const upperId = Number(newest.id);
    let afterId = 0;
    while (afterId < upperId) {
      const { data, error } = await this.client.from('token_usage')
        .select('id, prompt_tokens, completion_tokens, total_tokens, cached_tokens, system_tokens, tools_tokens, messages_tokens, created_at')
        .eq('user_id', userId).gte('created_at', since.toISOString())
        .gt('id', afterId).lte('id', upperId).order('id', { ascending: true }).limit(USAGE_PAGE_SIZE);
      if (error) throw new Error(`Failed to load token usage: ${error.message}`);
      const rows = (data ?? []) as UsageRow[];
      if (rows.length === 0) return;
      const nextId = Number(rows[rows.length - 1].id);
      if (nextId <= afterId) throw new Error('Token usage pagination did not advance');
      yield rows;
      afterId = nextId;
    }
  }

  async summariseTokenUsage(userId: number, since: Date): Promise<TokenUsageSummary> {
    const summary: TokenUsageSummary = {
      calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
      averagePromptTokens: 0, firstRecordedAt: null, lastRecordedAt: null,
    };
    for await (const rows of this.usagePages(userId, since)) {
      for (const row of rows) {
        summary.calls += 1;
        summary.promptTokens += row.prompt_tokens ?? 0;
        summary.completionTokens += row.completion_tokens ?? 0;
        summary.totalTokens += row.total_tokens ?? 0;
        summary.cachedTokens += row.cached_tokens ?? 0;
        if (summary.firstRecordedAt === null || row.created_at < summary.firstRecordedAt) summary.firstRecordedAt = row.created_at;
        if (summary.lastRecordedAt === null || row.created_at > summary.lastRecordedAt) summary.lastRecordedAt = row.created_at;
      }
    }
    summary.averagePromptTokens = summary.calls ? Math.round(summary.promptTokens / summary.calls) : 0;
    return summary;
  }

  async dailyTokenUsage(userId: number, days: number, timezone: string): Promise<DailyTokenUsage[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const buckets = new Map<string, {
      calls: number; prompt: number; completion: number; total: number; cached: number;
      system: number; tools: number; messages: number;
    }>();
    for await (const rows of this.usagePages(userId, since)) {
      for (const row of rows) {
        const date = new Date(row.created_at);
        if (Number.isNaN(date.getTime())) continue;
        const key = localDateKey(date, timezone);
        const day = buckets.get(key) ?? { calls: 0, prompt: 0, completion: 0, total: 0, cached: 0, system: 0, tools: 0, messages: 0 };
        day.calls += 1;
        day.prompt += row.prompt_tokens ?? 0;
        day.completion += row.completion_tokens ?? 0;
        day.total += row.total_tokens ?? 0;
        day.cached += row.cached_tokens ?? 0;
        day.system += row.system_tokens ?? 0;
        day.tools += row.tools_tokens ?? 0;
        day.messages += row.messages_tokens ?? 0;
        buckets.set(key, day);
      }
    }
    return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({
      date, calls: day.calls, promptTokens: day.prompt, completionTokens: day.completion,
      totalTokens: day.total, cachedTokens: day.cached,
      averagePromptTokens: Math.round(day.prompt / day.calls),
      averageSystemTokens: Math.round(day.system / day.calls),
      averageToolsTokens: Math.round(day.tools / day.calls),
      averageMessagesTokens: Math.round(day.messages / day.calls),
    }));
  }
}
