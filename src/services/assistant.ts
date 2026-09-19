import { logger } from './logger.js';
import type { AssistantStore } from './assistant-store.js';
import type { AIClient, AgentMessage } from './ai-client.js';
import type { ToolContext, ToolRegistry, ValidatedCall } from '../tools/registry.js';

export interface PendingConfirmation {
  id: number;
  summary: string;
  toolName: string;
  expiresAt: string;
}

export type ConversationReply =
  | { kind: 'message'; text: string }
  | { kind: 'confirmation'; confirmation: PendingConfirmation };

export interface AssistantServiceOptions {
  store: AssistantStore;
  registry: ToolRegistry;
  client: AIClient;
  timezone: string;
  now?: () => Date;
  /** How many past messages are replayed to the model. */
  historyLimit?: number;
  maxToolIterations?: number;
  confirmationTtlMs?: number;
}

const DEFAULT_HISTORY_LIMIT = 40;
const DEFAULT_MAX_ITERATIONS = 4;
const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** Used when the model fails; kept here so the bot layer stays provider-agnostic. */
const DEGRADED_REPLY = '🤖 Sorry, I am having trouble reaching my brain right now. Please try again.';

export class AssistantService {
  private readonly store: AssistantStore;
  private readonly registry: ToolRegistry;
  private readonly client: AIClient;
  private readonly timezone: string;
  private readonly now: () => Date;
  private readonly historyLimit: number;
  private readonly maxToolIterations: number;
  private readonly confirmationTtlMs: number;

  constructor(options: AssistantServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.client = options.client;
    this.timezone = options.timezone;
    this.now = options.now ?? (() => new Date());
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_ITERATIONS;
    this.confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  }

  /**
   * Runs one user message through the model, executing read tools inline and
   * stopping at the first write tool so the user can confirm it.
   */
  async processMessage(userId: number, text: string): Promise<ConversationReply> {
    const now = this.now();
    const history = await this.loadHistory(userId);

    try {
      await this.store.appendMessages([{ userId, role: 'user', content: text }]);
    } catch (error) {
      // Losing a turn of memory must not lose the conversation itself.
      logger.error('Failed to persist user message; continuing without memory', error);
    }

    const messages: AgentMessage[] = [
      // Persisted history uses 'model' (the database enum); the neutral
      // contract calls that role 'assistant'.
      ...history.map((message): AgentMessage => ({
        role: message.role === 'model' ? 'assistant' : 'user',
        content: message.content,
      })),
      { role: 'user', content: text },
    ];

    return await this.runLoop(userId, messages, now);
  }

  /** Executes a confirmed write tool and lets the model narrate the outcome. */
  async approvePendingAction(userId: number, actionId: number): Promise<ConversationReply> {
    const action = await this.store.getPendingAction(actionId, userId);

    if (!action) {
      return { kind: 'message', text: 'That confirmation has expired. Please ask me again.' };
    }

    if (new Date(action.expiresAt).getTime() <= this.now().getTime()) {
      await this.store.deletePendingAction(actionId);
      return { kind: 'message', text: 'That confirmation expired before it was approved, so nothing happened. Please ask me again.' };
    }

    const resolved = this.registry.resolve(action.toolName, action.args);
    if (!resolved.call) {
      await this.store.deletePendingAction(actionId);
      return { kind: 'message', text: `I could not complete that: ${resolved.error}` };
    }

    // Execute against the time the user originally asked, so "in 5 minutes"
    // does not silently shift by however long the confirmation took.
    const context: ToolContext = {
      userId,
      store: this.store,
      timezone: this.timezone,
      now: new Date(action.createdAt),
    };

    let result: string;
    try {
      result = await this.registry.execute(resolved.call, context);
    } catch (error) {
      logger.error(`Confirmed tool ${action.toolName} failed`, error);
      await this.store.deletePendingAction(actionId);
      return { kind: 'message', text: 'Something went wrong carrying that out. Nothing was changed.' };
    }

    await this.store.deletePendingAction(actionId);

    // Replay the original assistant turn plus the tool result so the model can
    // explain what happened in context.
    const messages: AgentMessage[] = [
      ...(action.modelParts as AgentMessage[]),
      {
        role: 'tool',
        toolCallId: this.toolCallIdFor(action.modelParts as AgentMessage[], action.toolName),
        content: result,
      },
    ];

    return await this.runLoop(userId, messages, this.now());
  }

  async rejectPendingAction(userId: number, actionId: number): Promise<ConversationReply> {
    const action = await this.store.getPendingAction(actionId, userId);
    if (action) {
      await this.store.deletePendingAction(actionId);
    }
    return { kind: 'message', text: 'Okay, cancelled — I did not do anything.' };
  }

  /** Deletes expired confirmations. Called by the reminder poll. */
  async pruneExpiredConfirmations(): Promise<number> {
    try {
      return await this.store.deleteExpiredPendingActions(this.now());
    } catch (error) {
      logger.error('Failed to prune expired confirmations', error);
      return 0;
    }
  }

  /** Wipes conversation memory for a user, leaving facts and reminders intact. */
  async forgetConversation(userId: number): Promise<void> {
    await this.store.clearMessages(userId);
  }

  /**
   * The store backing this service. Exposed so read-only commands report on
   * exactly the state the assistant is using.
   */
  getStore(): AssistantStore {
    return this.store;
  }

  private async loadHistory(userId: number) {
    try {
      return await this.store.getRecentMessages(userId, this.historyLimit);
    } catch (error) {
      logger.error('Failed to load conversation history; starting fresh', error);
      return [];
    }
  }

  /** Finds the id of the write call that was paused for confirmation. */
  private toolCallIdFor(messages: AgentMessage[], toolName: string): string {
    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        const match = message.toolCalls.find((call) => call.name === toolName);
        if (match) {
          return match.id;
        }
      }
    }
    return toolName;
  }

  private async runLoop(userId: number, messages: AgentMessage[], now: Date): Promise<ConversationReply> {
    const context: ToolContext = { userId, store: this.store, timezone: this.timezone, now };

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      const turn = await this.client.generate(messages, this.registry);

      if (turn.toolCalls.length === 0) {
        const text = turn.text.trim() || DEGRADED_REPLY;
        await this.remember(userId, text);
        return { kind: 'message', text };
      }

      messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });

      const writeCalls: ValidatedCall[] = [];

      for (const call of turn.toolCalls) {
        const resolved = this.registry.resolve(call.name, call.args);

        if (!resolved.call) {
          messages.push({ role: 'tool', toolCallId: call.id, content: resolved.error ?? 'Unknown tool', isError: true });
          continue;
        }

        if (resolved.call.tool.kind === 'write') {
          writeCalls.push(resolved.call);
          continue;
        }

        try {
          const result = await this.registry.execute(resolved.call, context);
          messages.push({ role: 'tool', toolCallId: call.id, content: result });
        } catch (error) {
          logger.error(`Tool ${call.name} failed`, error);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: 'The tool failed. Tell the user it did not work.',
            isError: true,
          });
        }
      }

      if (writeCalls.length > 0) {
        const primary = writeCalls[0];
        const summary = summarise(primary);
        const expiresAt = new Date(now.getTime() + this.confirmationTtlMs).toISOString();
        const action = await this.store.createPendingAction({
          userId,
          toolName: primary.tool.name,
          args: primary.args,
          // The assistant turn that requested the call, so the loop can resume
          // in context after the user confirms.
          modelParts: [messages[messages.length - 1]],
          expiresAt,
        });

        // Anything the model said before asking to act still gets said.
        if (turn.text.trim()) {
          await this.remember(userId, turn.text.trim());
        }

        return {
          kind: 'confirmation',
          confirmation: {
            id: action.id,
            summary,
            toolName: primary.tool.name,
            expiresAt,
          },
        };
      }
    }

    logger.warn('Tool loop hit its iteration cap', { userId });
    return {
      kind: 'message',
      text: 'I went round in circles trying to work that out. Could you rephrase it?',
    };
  }

  private async remember(userId: number, text: string): Promise<void> {
    try {
      await this.store.appendMessages([{ userId, role: 'model', content: text }]);
    } catch (error) {
      logger.error('Failed to persist assistant message', error);
    }
  }
}

function summarise(call: ValidatedCall): string {
  const entries = Object.entries(call.args);
  if (entries.length === 0) {
    return call.tool.name;
  }
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ');
}
