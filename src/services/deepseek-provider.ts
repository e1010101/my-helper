import { env } from '../config/env.js';
import { logger } from './logger.js';
import { buildToolNameIndex, type AIClient, type AgentMessage, type ModelTurn, type TokenUsage, type ToolCall } from './ai-client.js';

/**
 * DeepSeek client.
 *
 * Talks to DeepSeek's OpenAI-compatible /chat/completions endpoint with plain
 * fetch rather than pulling in an SDK — the surface used here is small and
 * stable, and it keeps the dependency list unchanged.
 *
 * Message translation is the part worth reading: the neutral conversation has
 * to be flattened into OpenAI's shape, where each tool result is its own
 * `role: "tool"` message carrying a `tool_call_id`.
 */

export interface DeepSeekOptions {
  apiKey?: string;
  model?: string;
  systemInstruction?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChoiceMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIResponse {
  choices?: { message?: OpenAIChoiceMessage; finish_reason?: string }[];
  usage?: OpenAIUsage;
  error?: { message?: string; type?: string };
}

/** Loose shape so this provider need not depend on the registry's full type. */
type RegistryLike = { list(): unknown[]; toFunctionDeclarations(): unknown[] };

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 60_000;

export class DeepSeekProvider implements AIClient {
  readonly name = 'deepseek';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DeepSeekOptions = {}) {
    const config = env.deepseek();
    this.apiKey = options.apiKey ?? config.apiKey;
    this.model = options.model ?? config.model;
    // Provider-independent: reading env.gemini() here would require a Gemini
    // key and break a DeepSeek-only deployment.
    this.systemInstruction = options.systemInstruction ?? env.personalityPrompt();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Flattens the neutral conversation into OpenAI chat messages.
   *
   * Exposed for testing: this is where a provider mismatch would surface, and
   * it is far cheaper to assert on than a live API call.
   */
  static toChatMessages(
    messages: AgentMessage[],
    systemInstruction: string
  ): Record<string, unknown>[] {
    const toolNames = buildToolNameIndex(messages);
    const out: Record<string, unknown>[] = [{ role: 'system', content: systemInstruction }];

    for (const message of messages) {
      if (message.role === 'user') {
        out.push({ role: 'user', content: message.content });
        continue;
      }

      if (message.role === 'assistant') {
        const entry: Record<string, unknown> = { role: 'assistant' };
        // OpenAI rejects null content alongside tool_calls in some gateways,
        // and rejects missing content otherwise, so always send a string.
        entry.content = message.content ?? '';
        if (message.toolCalls && message.toolCalls.length > 0) {
          entry.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          }));
        }
        out.push(entry);
        continue;
      }

      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: toolNames.get(message.toolCallId),
        content: message.content,
      });
    }

    return out;
  }

  private buildTools(registry?: RegistryLike): unknown[] | undefined {
    const declarations = registry?.toFunctionDeclarations() ?? [];
    if (declarations.length === 0) {
      return undefined;
    }
    return (declarations as {
      name: string;
      description: string;
      parametersJsonSchema: unknown;
    }[]).map((declaration) => ({
      type: 'function',
      function: {
        name: declaration.name,
        description: declaration.description,
        parameters: declaration.parametersJsonSchema,
      },
    }));
  }

  async generate(
    messages: AgentMessage[],
    registry?: RegistryLike,
    systemInstruction?: string
  ): Promise<ModelTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: DeepSeekProvider.toChatMessages(
        messages,
        systemInstruction ?? this.systemInstruction
      ),
    };

    const tools = this.buildTools(registry);
    if (tools) {
      body.tools = tools;
      // Let the model choose; forcing a tool call would break plain chat.
      body.tool_choice = 'auto';
    }

    const response = await this.post('/chat/completions', body);
    const message = response.choices?.[0]?.message;

    if (!message) {
      throw new Error('DeepSeek returned no choices');
    }

    const toolCalls: ToolCall[] = (message.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function!.name!,
        args: parseToolArguments(call.function?.arguments, call.function!.name!),
      }));

    return { text: message.content ?? '', toolCalls, usage: toTokenUsage(response.usage) };
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    const response = await this.post('/chat/completions', {
      model: this.model,
      messages: [
        { role: 'system', content: systemInstruction ?? this.systemInstruction },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices?.[0]?.message?.content ?? '';
  }

  private async post(path: string, body: Record<string, unknown>): Promise<OpenAIResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        // Surface the provider's own message: it is usually specific
        // ("Insufficient Balance", "invalid api key", "model not found").
        const detail = extractErrorDetail(text);
        throw new Error(`DeepSeek API ${response.status}: ${detail}`);
      }

      try {
        return JSON.parse(text) as OpenAIResponse;
      } catch {
        throw new Error(`DeepSeek returned a non-JSON response: ${text.slice(0, 200)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`DeepSeek request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Maps the provider's usage block onto our neutral shape. Returns undefined
 * when the response carried no accounting, so callers can tell "no data" from
 * "zero tokens".
 */
function toTokenUsage(usage: OpenAIUsage | undefined): TokenUsage | undefined {
  if (!usage || typeof usage.prompt_tokens !== 'number') {
    return undefined;
  }

  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens,
    ...(typeof cached === 'number' ? { cachedTokens: cached } : {}),
  };
}

/** Models occasionally emit arguments that fail to parse; log and use {}. */function parseToolArguments(raw: string | undefined, toolName: string): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn(`DeepSeek tool "${toolName}" returned non-object arguments`, { raw });
    return {};
  } catch {
    logger.warn(`DeepSeek tool "${toolName}" returned unparseable arguments`, { raw });
    return {};
  }
}

function extractErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as OpenAIResponse;
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // fall through to the raw body
  }
  return text.slice(0, 300) || 'no response body';
}
