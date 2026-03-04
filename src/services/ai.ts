import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { DynamicTool } from '@langchain/core/tools';
import { config } from '../config/env.js';
import { logger } from './logger.js';
import { createTasksTool, createVectorSearchTool } from './tools.js';

// ── Per-user conversation memory ────────────────────────────────────
const MAX_HISTORY = 10; // keep last 10 messages (5 turns)
const historyStore = new Map<number, BaseMessage[]>();

function getHistory(userId: number): BaseMessage[] {
    return historyStore.get(userId) || [];
}

function pushHistory(userId: number, ...msgs: BaseMessage[]) {
    const hist = getHistory(userId);
    hist.push(...msgs);
    // Trim to keep the last MAX_HISTORY messages
    if (hist.length > MAX_HISTORY) {
        historyStore.set(userId, hist.slice(hist.length - MAX_HISTORY));
    } else {
        historyStore.set(userId, hist);
    }
}

// ── LLM instances ───────────────────────────────────────────────────
// Plain chat model (no tools) for regular messages
const chatLLM = new ChatGoogleGenerativeAI({
    apiKey: config.gemini.apiKey,
    model: 'gemini-2.5-flash',
    maxOutputTokens: 2048,
});

// Agent model with tools bound (created per-user because tools are user-scoped)
const agentModels = new Map<number, ReturnType<typeof chatLLM.bindTools>>();
const userTools = new Map<number, Map<string, DynamicTool>>();

function getAgentModel(userId: number) {
    let model = agentModels.get(userId);
    if (!model) {
        const tools: DynamicTool[] = [
            createTasksTool(userId),
            createVectorSearchTool(userId),
        ];
        model = chatLLM.bindTools(tools);
        agentModels.set(userId, model);

        // Index tools by name for quick lookup during the tool-call loop
        const toolMap = new Map<string, DynamicTool>();
        for (const t of tools) {
            toolMap.set(t.name, t);
        }
        userTools.set(userId, toolMap);
    }
    return model;
}

// ── System prompt ───────────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = new SystemMessage(
    config.gemini.personalityPrompt +
    '\n\nYou have access to tools that let you look up the user\'s tasks and ' +
    'semantically search their saved content. Use these tools when the user ' +
    'asks about their tasks, prompts, or any previously saved information. ' +
    'Always prefer using the tools to provide accurate, up-to-date information ' +
    'rather than guessing.',
);

const CHAT_SYSTEM_PROMPT = new SystemMessage(config.gemini.personalityPrompt);

// ── Public API ──────────────────────────────────────────────────────

export class AIService {
    /**
     * Agentic response for /ask – runs a tool-calling loop.
     * The model decides whether to call tools or respond directly.
     */
    public async agentResponse(userId: number, input: string): Promise<string> {
        const MAX_ITERATIONS = 5;
        try {
            const model = getAgentModel(userId);
            const toolMap = userTools.get(userId)!;
            const history = getHistory(userId);

            const messages: BaseMessage[] = [
                AGENT_SYSTEM_PROMPT,
                ...history,
                new HumanMessage(input),
            ];

            let iterations = 0;
            while (iterations < MAX_ITERATIONS) {
                iterations++;
                const response = await model.invoke(messages);
                messages.push(response);

                // Check if the model wants to call tools
                const toolCalls = response.tool_calls;
                if (!toolCalls || toolCalls.length === 0) {
                    // No tool calls → final answer
                    const answer = typeof response.content === 'string'
                        ? response.content
                        : JSON.stringify(response.content);

                    // Save to memory
                    pushHistory(userId, new HumanMessage(input), new AIMessage(answer));
                    return answer || 'I have nothing to say.';
                }

                // Execute each tool call and feed results back
                for (const tc of toolCalls) {
                    const tool = toolMap.get(tc.name);
                    if (!tool) {
                        logger.warn(`Agent requested unknown tool: ${tc.name}`);
                        messages.push(new ToolMessage({
                            tool_call_id: tc.id ?? tc.name,
                            content: `Error: unknown tool "${tc.name}"`,
                        }));
                        continue;
                    }

                    logger.info(`[Agent] calling tool "${tc.name}" with args: ${JSON.stringify(tc.args)}`);
                    const toolResult = await tool.invoke(
                        typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
                    );
                    messages.push(new ToolMessage({
                        tool_call_id: tc.id ?? tc.name,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                    }));
                }
                // Loop back so the model can react to tool results
            }

            // If we hit max iterations, return whatever we have
            const last = messages[messages.length - 1];
            const fallback = typeof last.content === 'string' ? last.content : 'I ran out of thinking steps. Please try rephrasing.';
            pushHistory(userId, new HumanMessage(input), new AIMessage(fallback));
            return fallback;
        } catch (error) {
            logger.error('LangChain agent error', error);
            throw new Error('Failed to generate agent response');
        }
    }

    /**
     * Simple chat response for regular text messages (non-agentic).
     */
    public async generateResponse(userId: number, messageText: string): Promise<string> {
        try {
            const history = getHistory(userId);

            const messages: BaseMessage[] = [
                CHAT_SYSTEM_PROMPT,
                ...history,
                new HumanMessage(messageText),
            ];

            const response = await chatLLM.invoke(messages);
            const text = typeof response.content === 'string'
                ? response.content
                : JSON.stringify(response.content);

            pushHistory(userId, new HumanMessage(messageText), new AIMessage(text || ''));

            return text || 'I have nothing to say.';
        } catch (error) {
            logger.error('Gemini API Error', error);
            throw new Error('Failed to generate AI response');
        }
    }

    public clearHistory(userId: number) {
        historyStore.delete(userId);
        agentModels.delete(userId);
        userTools.delete(userId);
    }
}

export const aiService = new AIService();
