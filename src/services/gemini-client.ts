import { GoogleGenAI, type Content, type Tool } from '@google/genai';
import { env } from '../config/env.js';

/** A model turn that may contain text, function calls, or both. */
export interface ModelTurn {
  text: string;
  raw: Content;
}

export interface AIClient {
  generate(contents: Content[], tools?: Tool[]): Promise<ModelTurn>;
  /** Plain one-shot completion with no history or tools. */
  generateText(prompt: string): Promise<string>;
}

export class GeminiClient implements AIClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly systemInstruction: string;

  constructor(options?: { apiKey?: string; model?: string; systemInstruction?: string }) {
    const gemini = env.gemini();
    this.ai = new GoogleGenAI({ apiKey: options?.apiKey ?? gemini.apiKey });
    this.model = options?.model ?? 'gemini-2.5-flash';
    this.systemInstruction = options?.systemInstruction ?? gemini.personalityPrompt;
  }

  async generate(contents: Content[], tools?: Tool[]): Promise<ModelTurn> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: this.systemInstruction,
        ...(tools && tools.length > 0 ? { tools } : {}),
      },
    });

    const candidate = response.candidates?.[0];
    const raw: Content = candidate?.content ?? { role: 'model', parts: [] };

    return {
      text: response.text ?? '',
      raw,
    };
  }

  async generateText(prompt: string): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { systemInstruction: this.systemInstruction },
    });
    return response.text ?? '';
  }
}
