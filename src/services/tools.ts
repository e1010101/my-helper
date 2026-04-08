import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { HuggingFaceTransformersEmbeddings } from '@langchain/community/embeddings/huggingface_transformers';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';
import { db } from './database.js';
import { logger } from './logger.js';

// ── Shared Supabase client for the vector store ──────────────────────
const supabaseClient = createClient(config.supabase.url, config.supabase.anonKey);

// ── Embeddings model ─────────────────────────────────────────────────
const embeddings = new HuggingFaceTransformersEmbeddings({
    model: 'Xenova/all-mpnet-base-v2', // 768-dimensional embeddings to match existing Supabase pgvector setup
});

// ── Vector store (lazy singleton) ────────────────────────────────────
let vectorStoreInstance: SupabaseVectorStore | null = null;

function getVectorStore(): SupabaseVectorStore {
    if (!vectorStoreInstance) {
        vectorStoreInstance = new SupabaseVectorStore(embeddings, {
            client: supabaseClient,
            tableName: 'app_embeddings',
            queryName: 'match_documents',
        });
    }
    return vectorStoreInstance;
}

// Re-export for external consumers that need to add documents
export { getVectorStore, embeddings };

// ── Tool definitions ─────────────────────────────────────────────────

/**
 * TasksTool – retrieves the current user's task list from the database.
 * The agent calls this when the user asks about their tasks.
 */
export function createTasksTool(userId: number): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'get_user_tasks',
        schema: z.object({
            input: z.string().optional().describe('Optional input that is ignored for this tool'),
        }),
        description:
            'Fetches the current user\'s task list from the database. ' +
            'Returns task id, name, description, completed status, and creation date. ' +
            'Use this when the user asks about their tasks, to-dos, or work items. ' +
            'IMPORTANT: When this returns tasks, you MUST list them ALL out to the user in a readable format. ' +
            'Do not just ask which task they want to see; output the full list of tasks, including their descriptions and status.',
        func: async (): Promise<string> => {
            try {
                const tasks = await db.getTasksByUser(userId, 20);
                if (tasks.length === 0) {
                    return 'The user has no tasks.';
                }
                return JSON.stringify(
                    tasks.map((t) => ({
                        id: t.id,
                        name: t.name,
                        description: t.description,
                        completed: t.completed,
                        created_at: t.created_at,
                    })),
                );
            } catch (error) {
                logger.error('TasksTool error', error);
                return 'Error: could not fetch tasks.';
            }
        },
    });
}

/**
 * VectorSearchTool – performs semantic search across all embedded app content
 * (tasks, prompts, etc.) using LangChain's SupabaseVectorStore retriever.
 */
export function createVectorSearchTool(userId: number): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'semantic_search',
        schema: z.object({
            query: z.string().describe('The natural-language search query to find documents about.'),
        }),
        description:
            'Performs a semantic / similarity search across saved prompts, tasks, and other indexed content. ' +
            'Input should be a natural-language query string describing what the user is looking for. ' +
            'Use this when the user asks you to find, recall, or look up previously saved information.',
        func: async ({ query }: { query: string }): Promise<string> => {
            try {
                const store = getVectorStore();
                const results = await store.similaritySearch(query, 5, {
                    user_id: userId,
                });

                if (results.length === 0) {
                    return 'No matching documents found.';
                }

                return JSON.stringify(
                    results.map((doc) => ({
                        content: doc.pageContent,
                        metadata: doc.metadata,
                    })),
                );
            } catch (error) {
                logger.error('VectorSearchTool error', error);
                return 'Error: could not perform semantic search.';
            }
        },
    });
}
