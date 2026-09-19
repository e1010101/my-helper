/**
 * Extra assistant controls that are not part of the tool set, registered
 * separately so commands/index.ts stays focused on the original bot commands.
 */
import type { Telegraf, Context } from 'telegraf';
import type { AssistantService } from '../services/assistant.js';
import { escapeHtml } from '../utils/telegram-format.js';
import { formatLocal } from '../services/reminder-time.js';

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
      const [facts, messages, reminders] = await Promise.all([
        store.listFacts(userId),
        store.countMessages(userId),
        store.listReminders(userId),
      ]);

      const factsText = facts.length > 0
        ? facts.map((fact) => `• <b>${escapeHtml(fact.key)}</b>: ${escapeHtml(fact.value)}`).join('\n')
        : '(none yet)';

      const reminderText = reminders.length > 0
        ? reminders
          .map((reminder) => `• #${reminder.id} ${escapeHtml(reminder.text)} — ${escapeHtml(formatLocal(new Date(reminder.nextRunAt), timezone))}${reminder.frequency === 'once' ? '' : ` (${reminder.frequency})`}`)
          .join('\n')
        : '(none)';

      await ctx.reply(
        `🧠 <b>What I remember</b>\n\n` +
        `<b>Facts &amp; preferences</b>\n${factsText}\n\n` +
        `<b>Reminders</b>\n${reminderText}\n\n` +
        `<b>Conversation</b>\n${messages} stored message(s)`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Memory command error:', error);
      await ctx.reply('❌ Failed to read stored memory.');
    }
  });
}
