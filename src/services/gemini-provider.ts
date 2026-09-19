import { GoogleGenAI, createPartFromFunctionResponse, createPartFromText, type Content, type Part } from '@google/genai';
import { env } from '../config/env.js';
import { buildToolNameIndex, type AIClient, type AgentMessage, type ModelTurn } from './ai-client.js';
import type { ToolRegistry } from '../tools/registry.js';

/** Loose shape so this provider need not depend on the registry's full type. */
type RegistryLike = { list(): unknown[]; toFunctionDeclarations(): unknown[] };

interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  systemInstruction?: string;
}

export class GeminiProvider implements AIClient {
  readonly name = 'gemini';

  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly systemInstruction: string;

  constructor(options: GeminiClientOptions = {}) {
    const gemini = env.gemini();
    this.ai = new GoogleGenAI({ apiKey: options.apiKey ?? gemini.apiKey });
    this.model = options.model ?? 'gemini-2.5-flash';
    this.systemInstruction = options.systemInstruction ?? env.personalityPrompt();
  }

  /** Maps the neutral conversation onto Gemini's Content[] shape. */
  static toContents(messages: AgentMessage[]): Content[] {
    const toolNames = buildToolNameIndex(messages);
    const contents: Content[] = [];

    for (const message of messages) {
      if (message.role === 'user') {
        contents.push({ role: 'user', parts: [createPartFromText(message.content)] });
        continue;
      }

      if (message.role === 'assistant') {
        const parts: Part[] = [];
        if (message.content) {
          parts.push(createPartFromText(message.content));
        }
        for (const call of message.toolCalls ?? []) {
          parts.push({ functionCall: { id: call.id, name: call.name, args: call.args } });
        }
        // Gemini rejects an empty parts array.
        contents.push({ role: 'model', parts: parts.length > 0 ? parts : [createPartFromText('')] });
        continue;
      }

      // Tool results must arrive as a user turn containing functionResponse parts.
      contents.push({
        role: 'user',
        parts: [
          createPartFromFunctionResponse(
            message.toolCallId,
            toolNames.get(message.toolCallId) ?? message.toolCallId,
            message.isError ? { error: message.content } : { result: message.content }
          ),
        ],
      });
    }

    return contents;
  }

  async generate(
    messages: AgentMessage[],
    registry?: ToolRegistry | RegistryLike,
    systemInstruction?: string
  ): Promise<ModelTurn> {
    const tools = registry?.toFunctionDeclarations() ?? [];

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: GeminiProvider.toContents(messages),
      config: {
        systemInstruction: systemInstruction ?? this.systemInstruction,
        ...(tools.length > 0
          ? {
            tools: [
              {
                functionDeclarations: (tools as {
                  name: string;
                  description: string;
                  parametersJsonSchema: unknown;
                }[]).map((declaration) => ({
                  name: declaration.name,
                  description: declaration.description,
                  parametersJsonSchema: declaration.parametersJsonSchema,
                })),
              },
            ],
          }
          : {}),
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = parts
      .map((part) => (part as { functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }).functionCall)
      .filter((call): call is { id?: string; name: string; args?: Record<string, unknown> } => Boolean(call?.name))
      .map((call, index) => ({
        id: call.id ?? `${call.name}-${index}`,
        name: call.name,
        args: call.args ?? {},
      }));

    return { text: response.text ?? '', toolCalls };
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    // Accepting the instruction keeps the AIClient contract uniform: a caller
    // must not have to know which provider it holds.
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { systemInstruction: systemInstruction ?? this.systemInstruction ?? env.systemInstruction() },
    });
    return response.text ?? '';
  }
}
