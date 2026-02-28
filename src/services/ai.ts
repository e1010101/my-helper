import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env.js';
import { logger } from './logger.js';

export interface ChatMessage {
    role: 'user' | 'model';
    parts: { text: string }[];
}

export class AIService {
    private ai: GoogleGenAI;
    // Simple in-memory context store: userId -> ChatMessage[]
    private contextStore: Map<number, ChatMessage[]> = new Map();
    // 10 messages = 5 turns
    private readonly MAX_HISTORY_LENGTH = 10;

    constructor() {
        this.ai = new GoogleGenAI({
            apiKey: config.gemini.apiKey,
        });
    }

    private getHistory(userId: number): ChatMessage[] {
        return this.contextStore.get(userId) || [];
    }

    private saveHistory(userId: number, messages: ChatMessage[]) {
        // Keep only the last MAX_HISTORY_LENGTH messages
        if (messages.length > this.MAX_HISTORY_LENGTH) {
            messages = messages.slice(messages.length - this.MAX_HISTORY_LENGTH);
        }
        this.contextStore.set(userId, messages);
    }

    public async generateResponse(userId: number, messageText: string): Promise<string> {
        try {
            const history = this.getHistory(userId);

            // V1 context management: We create a new chat instance but feed it the history manually if needed,
            // or we can use the GenAI SDK's build-in chat history by initializing chat with history.
            // For now, let's use the SDK's chat history feature cleanly.

            // We will re-create the chat with the stored history to maintain context
            const chatSession = this.ai.chats.create({
                model: 'gemini-2.5-flash',
                config: {
                    systemInstruction: config.gemini.personalityPrompt,
                },
                history: history.length > 0 ? history : undefined,
            });

            const response = await chatSession.sendMessage({ message: messageText });

            // Update our history store with the new messages
            // The GenAI SDK's chatSession.getHistory() might be asynchronous or synchronous depending on the SDK version,
            // But typically we can just append to our own state or extract it.
            // For now, let's just push manually to our store to be safe.

            history.push({ role: 'user', parts: [{ text: messageText }] });
            history.push({ role: 'model', parts: [{ text: response.text || '' }] });
            this.saveHistory(userId, history);

            return response.text || 'I have nothing to say.';
        } catch (error) {
            logger.error('Gemini API Error', error);
            throw new Error('Failed to generate AI response');
        }
    }

    public clearHistory(userId: number) {
        this.contextStore.delete(userId);
    }
}

export const aiService = new AIService();
