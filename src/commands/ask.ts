import { Context, Markup } from 'telegraf';
import { aiService } from '../services/ai.js';
import { logger } from '../services/logger.js';

/**
 * /ask <question>  –  agentic search command
 *
 * Runs the user's question through the LangChain AgentExecutor which has
 * access to TasksTool and VectorSearchTool.  The response is sent back
 * with inline 👍 / 👎 feedback buttons.
 */
export async function askCommand(ctx: Context) {
    const userId = ctx.from?.id;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

    if (!userId) {
        await ctx.reply('❌ Could not identify user');
        return;
    }

    // Strip the "/ask" prefix and trim
    const question = text.replace(/^\/ask\s*/i, '').trim();

    if (!question) {
        await ctx.reply(
            '❓ Please provide a question after the command.\n\nUsage: `/ask What tasks do I have today?`',
            { parse_mode: 'Markdown' },
        );
        return;
    }

    try {
        await ctx.sendChatAction('typing');
        logger.info(`[/ask] userId=${userId} question="${question}"`);

        const answer = await aiService.agentResponse(userId, question);

        // Build feedback keyboard
        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('👍', `ask_feedback:thumbs_up`),
            Markup.button.callback('👎', `ask_feedback:thumbs_down`),
        ]);

        await ctx.reply(answer, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
        });
    } catch (error) {
        logger.error('[/ask] error', error);
        await ctx.reply(
            '🤖 Sorry, I had trouble processing your question. Please try again later.',
        );
    }
}
