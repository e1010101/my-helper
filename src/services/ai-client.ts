/**
 * Provider-neutral contract for the model layer.
 *
 * The assistant loop talks in these terms only, so swapping Gemini for
 * DeepSeek (or anything else) is a matter of implementing `AIClient` plus the
 * message translation — no changes to the tool loop or its tests.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

/**
 * Token accounting as reported by the provider.
 *
 * Optional because not every provider returns it on every response, and the
 * loop must not depend on it to function — it exists for measurement.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache, when reported. */
  cachedTokens?: number;
}

/** One model turn: text, tool calls, or both. */
export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

export interface AIClient {
  /** Provider name, for logging. */
  readonly name: string;
  /** Concrete model in use, recorded alongside token usage so a change is visible. */
  readonly model: string;
  /**
   * One model turn. The registry supplies the tools the model may call; it is
   * typed loosely to keep this contract free of a circular import.
   *
   * `systemInstruction` is per-request because it carries the current time,
   * which must not go stale.
   */
  generate(
    messages: AgentMessage[],
    registry?: { list(): unknown[]; toFunctionDeclarations(): unknown[] },
    systemInstruction?: string
  ): Promise<ModelTurn>;
  /** Plain one-shot completion with no history or tools. */
  generateText(prompt: string, systemInstruction?: string): Promise<string>;
}

/**
 * Gemini requires every function call to be answered by a matching response in
 * the same conversation. Providers need the tool name, which the neutral
 * `tool` message does not carry, so it is recovered from the assistant turn
 * that requested the call.
 */
export function buildToolNameIndex(messages: AgentMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        index.set(call.id, call.name);
      }
    }
  }
  return index;
}
