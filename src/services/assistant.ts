import { createPartFromFunctionResponse, createPartFromText, createUserContent, type Content, type Part } from '@google/genai';
import { logger } from './logger.js';
import type { AssistantStore } from './assistant-store.js';
import type { AIClient } from './gemini-client.js';
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

/** Models the reply these tools produce; kept for graceful degradation. */
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

    const contents: Content[] = [
      ...history.map((message) => ({
        role: message.role,
        parts: [createPartFromText(message.content)],
      })),
      createUserContent(text),
    ];

    return await this.runLoop(userId, contents, now);
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

    // Replay the original function-call turn plus its result so the model can
    // explain what happened in context.
    const contents: Content[] = [
      ...(action.modelParts as Content[]),
      createUserContent([createFunctionResponsePart({ name: action.toolName }, { result })]),
    ];

    return await this.runLoop(userId, contents, this.now());
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

  private async runLoop(userId: number, contents: Content[], now: Date): Promise<ConversationReply> {
    const tools = this.registry.list().length > 0
      ? [{ functionDeclarations: this.registry.toFunctionDeclarations() }]
      : undefined;

    const context: ToolContext = { userId, store: this.store, timezone: this.timezone, now };

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      const turn = await this.client.generate(contents, tools);
      const functionCalls = collectFunctionCalls(turn.raw);

      if (functionCalls.length === 0) {
        const text = turn.text.trim() || DEGRADED_REPLY;
        await this.remember(userId, text);
        return { kind: 'message', text };
      }

      contents.push(turn.raw);

      const results: Part[] = [];
      const writeCalls: ValidatedCall[] = [];

      for (const call of functionCalls) {
        const resolved = this.registry.resolve(call.name, call.args);

        if (!resolved.call) {
          results.push(createFunctionResponsePart(call, { error: resolved.error }));
          continue;
        }

        if (resolved.call.tool.kind === 'write') {
          writeCalls.push(resolved.call);
          continue;
        }

        try {
          const result = await this.registry.execute(resolved.call, context);
          results.push(createFunctionResponsePart(call, { result }));
        } catch (error) {
          logger.error(`Tool ${call.name} failed`, error);
          results.push(
            createFunctionResponsePart(call, {
              error: 'The tool failed. Tell the user it did not work.',
            })
          );
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
          modelParts: [turn.raw],
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

      if (results.length === 0) {
        const text = turn.text.trim() || DEGRADED_REPLY;
        await this.remember(userId, text);
        return { kind: 'message', text };
      }

      contents.push(createUserContent(results));
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

interface RawFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

function collectFunctionCalls(content: Content): RawFunctionCall[] {
  const parts = content.parts ?? [];
  return parts
    .map((part) => (part as { functionCall?: RawFunctionCall }).functionCall)
    .filter((call): call is RawFunctionCall => Boolean(call?.name));
}

/**
 * Gemini requires every function call to be answered by a matching response,
 * keyed by the call id, otherwise the next request is rejected.
 */
function createFunctionResponsePart(
  call: RawFunctionCall,
  payload: Record<string, unknown>
): Part {
  return createPartFromFunctionResponse(call.id ?? call.name, call.name, payload);
}

function summarise(call: ValidatedCall): string {
  const entries = Object.entries(call.args);
  if (entries.length === 0) {
    return call.tool.name;
  }
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ');
}
