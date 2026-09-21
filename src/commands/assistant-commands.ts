import type { Telegraf, Context } from 'telegraf';
import type { AssistantService } from '../services/assistant.js';
import { formatFacts, formatReminders, formatUsage } from '../utils/memory-format.js';

/** How far back the token usage summary looks. */
const USAGE_WINDOW_DAYS = 30;

export function registerAssistantCommands(
  bot: Telegraf,
  assistant: AssistantService,
  timezone: string
): void {
  // The store is resolved per call rather than captured at registration, so
  // these commands always report the assistant's real state.
  bot.command('forget', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Could not identify user');
      return;
    }

    try {
      await assistant.forgetConversation(userId);
      await ctx.reply('🧹 Conversation memory cleared. Reminders and saved facts are untouched.');
    } catch (error) {
      console.error('Forget command error:', error);
      await ctx.reply('❌ Failed to clear conversation memory.');
    }
  });

  bot.command('memory', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Could not identify user');
      return;
    }

    try {
      const store = assistant.getStore();
      const usageSince = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000);

      const [facts, messages, reminders, usage] = await Promise.all([
        store.listFacts(userId),
        store.countMessages(userId),
        store.listReminders(userId),
        // Usage is the newest addition, so a database predating the table would
        // otherwise break the whole command. Degrade to a note instead.
        store.summariseTokenUsage(userId, usageSince).catch(() => null),
      ]);

      const usageText = usage
        ? formatUsage(usage, USAGE_WINDOW_DAYS)
        : '(unavailable — has the token_usage table been created?)';

      await ctx.reply(
        `🧠 <b>What I remember</b>\n\n` +
        `<b>Facts &amp; preferences</b>\n${formatFacts(facts)}\n\n` +
        `<b>Reminders</b>\n${formatReminders(reminders, timezone)}\n\n` +
        `<b>Conversation</b>\n${messages} stored message(s)\n\n` +
        `<b>Token usage</b>\n${usageText}`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Memory command error:', error);
      await ctx.reply('❌ Failed to read stored memory.');
    }
  });
}
