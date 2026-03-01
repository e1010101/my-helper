import { Context, Markup } from 'telegraf';

interface PromptSearchResult {
    id: number;
    title: string;
    prompt: string;
    tags: string[];
    image_file_id: string;
    created_at: string;
    updated_at: string;
}

interface PromptPaginationState {
    chatId: number;
    messageId: number;
    results: PromptSearchResult[];
    currentIndex: number;
}

const paginationStates = new Map<number, PromptPaginationState>();

function parseGetPromptArgs(text: string): { titleQuery?: string; tagsQuery?: string[] } {
    const args = text.split(' ').slice(1).join(' '); // Remove '/getprompt'
    const titleMatch = args.match(/-title\s+([^-]+)(?=\s+-|$)/i);
    const tagMatch = args.match(/-tag\s+([^-]+)(?=\s+-|$)/i);

    const titleQuery = titleMatch ? titleMatch[1].trim() : undefined;
    let tagsQuery: string[] | undefined;

    if (tagMatch) {
        tagsQuery = tagMatch[1]
            .split(',')
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0);
    }

    return { titleQuery, tagsQuery };
}

function getPaginationKeyboard(currentIndex: number, total: number) {
    const buttons = [];
    if (currentIndex > 0) {
        buttons.push(Markup.button.callback('⬅️ Previous', 'getprompt:prev'));
    }
    if (currentIndex < total - 1) {
        buttons.push(Markup.button.callback('Next ➡️', 'getprompt:next'));
    }
    return Markup.inlineKeyboard([buttons]);
}

function formatPromptCaption(prompt: PromptSearchResult, currentIndex: number, total: number): string {
    const tagsStr = prompt.tags && prompt.tags.length > 0 ? prompt.tags.join(', ') : 'None';
    return `📄 *Result ${currentIndex + 1} of ${total}*\n\n` +
        `*Title:* ${prompt.title}\n` +
        `*Tags:* ${tagsStr}\n\n` +
        `*Prompt Text:*\n${prompt.prompt}`;
}

export async function getPromptCommand(ctx: Context) {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

    if (!userId || !chatId) {
        await ctx.reply('❌ Could not identify user');
        return;
    }

    const { titleQuery, tagsQuery } = parseGetPromptArgs(text);

    if (!titleQuery && (!tagsQuery || tagsQuery.length === 0)) {
        await ctx.reply(
            '❌ Please provide search criteria. Usage:\n`/getprompt -title <text>`\n`/getprompt -tag <tag1,tag2>`\n`/getprompt -title <text> -tag <tag1,tag2>`',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    try {
        const { db } = await import('../services/database.js');
        await ctx.sendChatAction('typing');
        const results = await db.searchPrompts(userId, titleQuery, tagsQuery);

        if (results.length === 0) {
            await ctx.reply('🔍 No prompts found matching your criteria.');
            return;
        }

        const firstResult = results[0];
        const caption = formatPromptCaption(firstResult, 0, results.length);
        const keyboard = getPaginationKeyboard(0, results.length);

        const sentMessage = await ctx.replyWithPhoto(firstResult.image_file_id, {
            caption,
            parse_mode: 'Markdown',
            reply_markup: results.length > 1 ? keyboard.reply_markup : undefined,
        });

        if (results.length > 1) {
            paginationStates.set(userId, {
                chatId,
                messageId: sentMessage.message_id,
                results,
                currentIndex: 0,
            });
        }
    } catch (error) {
        console.error('Error fetching prompts:', error);
        await ctx.reply('❌ Failed to search prompts. Please try again later.');
    }
}

export async function getPromptActionHandler(ctx: Context) {
    const userId = ctx.from?.id;
    const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';

    if (!userId || !callbackData) {
        await ctx.answerCbQuery();
        return;
    }

    const state = paginationStates.get(userId);
    if (!state) {
        await ctx.answerCbQuery('Pagination session expired. Please run /getprompt again.', { show_alert: true });
        return;
    }

    let newIndex = state.currentIndex;
    if (callbackData === 'getprompt:next' && newIndex < state.results.length - 1) {
        newIndex++;
    } else if (callbackData === 'getprompt:prev' && newIndex > 0) {
        newIndex--;
    } else {
        await ctx.answerCbQuery();
        return;
    }

    state.currentIndex = newIndex;
    const currentResult = state.results[newIndex];
    const caption = formatPromptCaption(currentResult, newIndex, state.results.length);
    const keyboard = getPaginationKeyboard(newIndex, state.results.length);

    try {
        await ctx.telegram.editMessageMedia(
            state.chatId,
            state.messageId,
            undefined,
            {
                type: 'photo',
                media: currentResult.image_file_id,
                caption,
                parse_mode: 'Markdown',
            },
            {
                reply_markup: keyboard.reply_markup,
            }
        );

        paginationStates.set(userId, state);
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error updating paginated prompt message:', error);
        await ctx.answerCbQuery('Failed to load image. It may have been deleted.', { show_alert: true });
    }
}
