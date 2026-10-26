import { Context, Markup } from 'telegraf';
import { db, Prompt } from '../services/database.js';
import { escapeHtml } from '../utils/telegram-format.js';
import { splitTelegramHtml } from '../utils/telegram-chunk.js';

interface PromptPaginationState {
    chatId: number;
    messageId: number;
    results: Prompt[];
    currentIndex: number;
}

const paginationStates = new Map<number, PromptPaginationState>();

/** Telegram allows at most 1024 characters in a photo caption. */
const MAX_CAPTION_LENGTH = 1024;

interface SearchArgs {
    titleQuery?: string;
    tagsQuery?: string[];
}

/**
 * Parses `/getprompt -title <text> -tag <a,b>`.
 *
 * Values are read up to the next known flag rather than up to the next hyphen,
 * so values containing hyphens ("my-prompt", "gpt-4") are kept intact.
 */
export function parseGetPromptArgs(text: string): SearchArgs {
    const args = text.split(' ').slice(1).join(' ').trim();
    const parsed: SearchArgs = {};

    const flagPattern = /-(title|tag)\b/gi;
    const matches = [...args.matchAll(flagPattern)];

    for (let i = 0; i < matches.length; i++) {
        const flag = matches[i][1].toLowerCase();
        const valueStart = (matches[i].index ?? 0) + matches[i][0].length;
        const valueEnd = i + 1 < matches.length ? matches[i + 1].index : args.length;
        const value = args.slice(valueStart, valueEnd).trim();

        if (!value) {
            continue;
        }

        if (flag === 'title') {
            parsed.titleQuery = value;
        } else {
            parsed.tagsQuery = value
                .split(',')
                .map(tag => tag.trim())
                .filter(tag => tag.length > 0);
        }
    }

    return parsed;
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

function formatPromptOutput(prompt: Prompt, currentIndex: number, total: number): { caption: string; details: string[] } {
    const tagsStr = prompt.tags && prompt.tags.length > 0
        ? prompt.tags.map(escapeHtml).join(', ')
        : 'None';

    const header = `📄 <b>Result ${currentIndex + 1} of ${total}</b>\n\n` +
        `<b>Title:</b> ${escapeHtml(prompt.title)}\n` +
        `<b>Tags:</b> ${tagsStr}\n\n` +
        `<b>Prompt Text:</b>\n`;

    const body = escapeHtml(prompt.prompt ?? '');
    const full = header + body;

    // Split before choosing a caption so tags and HTML entities are never cut.
    // When any field is too long, keep the photo caption short and send all
    // saved fields as regular messages; nothing is lost to a preview limit.
    const captionParts = splitTelegramHtml(full, MAX_CAPTION_LENGTH);
    if (captionParts.length === 1) {
        return { caption: captionParts[0], details: [] };
    }
    return {
        caption: `📄 <b>Result ${currentIndex + 1} of ${total}</b>\n\nFull prompt details follow below.`,
        details: splitTelegramHtml(full),
    };
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
            '❌ Please provide search criteria. Usage:\n' +
            '<code>/getprompt -title &lt;text&gt;</code>\n' +
            '<code>/getprompt -tag &lt;tag1,tag2&gt;</code>\n' +
            '<code>/getprompt -title &lt;text&gt; -tag &lt;tag1,tag2&gt;</code>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    try {
        await ctx.sendChatAction('typing');
        const results = await db.searchPrompts(userId, titleQuery, tagsQuery);

        if (results.length === 0) {
            await ctx.reply('🔍 No prompts found matching your criteria.');
            return;
        }

        const firstResult = results[0];
        const { caption, details } = formatPromptOutput(firstResult, 0, results.length);
        const keyboard = getPaginationKeyboard(0, results.length);

        const sentMessage = await ctx.replyWithPhoto(firstResult.image_file_id, {
            caption,
            parse_mode: 'HTML',
            reply_markup: results.length > 1 ? keyboard.reply_markup : undefined,
        });

        for (const chunk of details) await ctx.reply(chunk, { parse_mode: 'HTML' });

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
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!state || state.chatId !== message?.chat.id || state.messageId !== message?.message_id) {
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

    const currentResult = state.results[newIndex];
    if (!currentResult) {
        await ctx.answerCbQuery('That result is no longer available.', { show_alert: true });
        return;
    }

    const { caption, details } = formatPromptOutput(currentResult, newIndex, state.results.length);
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
                parse_mode: 'HTML',
            },
            {
                reply_markup: keyboard.reply_markup,
            }
        );

        state.currentIndex = newIndex;
        paginationStates.set(userId, state);
        for (const chunk of details) {
            await ctx.telegram.sendMessage(state.chatId, chunk, { parse_mode: 'HTML' });
        }
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error updating paginated prompt message:', error);
        await ctx.answerCbQuery('Failed to load image. It may have been deleted.', { show_alert: true });
    }
}
