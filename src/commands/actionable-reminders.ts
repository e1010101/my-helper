import { Markup, type Context, type Telegraf } from 'telegraf';
import {
  FOLLOW_UP_DELAY_MINUTES,
  MAX_FOLLOW_UP_ATTEMPTS_PER_DAY,
  MAX_FOLLOW_UPS_PER_OCCURRENCE,
  type ReminderActionStore,
  type ReminderOccurrence,
  type ReminderPreferences,
  type ReminderPreferencesPatch,
} from '../services/reminder-action-store.js';
import { snoozeUntil, validateReminderPreferences } from '../services/reminder-policy.js';
import { formatLocal } from '../services/reminder-time.js';
import { escapeHtml } from '../utils/telegram-format.js';
import { splitTelegramHtml } from '../utils/telegram-chunk.js';

interface ActionableReminderOptions {
  getStore: () => ReminderActionStore;
  timezone: string;
  now?: () => Date;
}

const PENDING_LIMIT = 50;
const SETTINGS_USAGE = 'Use /reminders quiet 22:00 08:00 to set quiet hours, /reminders quiet off to disable them, or /reminders followups on|off.';

/** Full reminder text; callers split this HTML before sending to Telegram. */
export function occurrenceMessage(occurrence: ReminderOccurrence, timezone: string): string {
  const heading = occurrence.notificationKind === 'followup' ? 'Reminder follow-up' : 'Reminder';
  const scheduled = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(occurrence.scheduledFor));
  return `⏰ <b>${heading} [Occurrence: ${occurrence.id}]</b>\n\n`
    + `${escapeHtml(occurrence.text)}\n\n`
    + `<b>Scheduled:</b> ${escapeHtml(scheduled)} (${escapeHtml(timezone)})\n`
    + `<b>Reminder ID:</b> ${occurrence.reminderId}\n`
    + 'Done and Skip apply to this occurrence. Recurring reminders keep their schedule.';
}

export function occurrenceKeyboard(occurrence: ReminderOccurrence) {
  if (occurrence.status !== 'pending') return { inline_keyboard: [] };
  const callback = (label: string, action: string) => Markup.button.callback(label, `occ:${action}:${occurrence.id}:${occurrence.version}`);
  return Markup.inlineKeyboard([
    [callback('✅ Done', 'done'), callback('Skip', 'skip')],
    [callback('Snooze 10m', '10m'), callback('Snooze 1h', '1h'), callback('Tomorrow 09:00', 'tomorrow')],
  ]).reply_markup;
}

function preferencesMessage(preferences: ReminderPreferences, timezone: string): string {
  const quiet = preferences.quietHoursStart && preferences.quietHoursEnd
    ? `${preferences.quietHoursStart}–${preferences.quietHoursEnd}`
    : 'Off';
  return '<b>Reminder settings</b>\n\n'
    + `<b>Quiet hours:</b> ${escapeHtml(quiet)} (${escapeHtml(timezone)})\n`
    + `<b>Follow-ups:</b> ${preferences.followUpsEnabled ? 'On' : 'Off'}\n\n`
    + `Opt-in follow-ups: up to ${MAX_FOLLOW_UPS_PER_OCCURRENCE} per occurrence, at least ${FOLLOW_UP_DELAY_MINUTES} minutes apart; at most ${MAX_FOLLOW_UP_ATTEMPTS_PER_DAY} attempts per local day. `
    + 'Enabling applies to future deliveries. Turning off cancels queued follow-ups.\n'
    + 'Quiet hours defer reminders, snoozes and follow-ups until the quiet period ends. Tomorrow snoozes to 09:00 in the timezone above.\n\n'
    + SETTINGS_USAGE;
}

function preferencesKeyboard(userId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Follow-ups ON', `reminderprefs:on:${userId}`), Markup.button.callback('Follow-ups OFF', `reminderprefs:off:${userId}`)],
    [Markup.button.callback('Quiet hours OFF', `reminderprefs:quietoff:${userId}`)],
  ]).reply_markup;
}

async function sendPreferences(ctx: Context, preferences: ReminderPreferences, timezone: string): Promise<void> {
  await ctx.reply(preferencesMessage(preferences, timezone), { parse_mode: 'HTML', reply_markup: preferencesKeyboard(preferences.userId) });
}

export function registerActionableReminderCommands(bot: Telegraf, options: ActionableReminderOptions): void {
  const { getStore, timezone } = options;
  const now = options.now ?? (() => new Date());

  bot.command('pending', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      const store = getStore();
      // Occurrences outlive inactive one-off series, so never derive this from listReminders.
      const pending = await store.listPendingReminderOccurrences(userId, PENDING_LIMIT + 1);
      if (pending.length === 0) {
        await ctx.reply('No pending reminders. Use /tasks to manage reminder schedules.');
        return;
      }
      await ctx.reply(`⏰ Pending reminders${pending.length > PENDING_LIMIT ? ` (showing the first ${PENDING_LIMIT})` : ` (${pending.length})`}. Use Done, Snooze or Skip below.`);
      for (const occurrence of pending.slice(0, PENDING_LIMIT)) {
        const chunks = splitTelegramHtml(occurrenceMessage(occurrence, timezone));
        for (let index = 0; index < chunks.length; index++) {
          await ctx.reply(chunks[index], { parse_mode: 'HTML', ...(index === chunks.length - 1 ? { reply_markup: occurrenceKeyboard(occurrence) } : {}) });
        }
      }
      if (pending.length > PENDING_LIMIT) await ctx.reply('More pending reminders remain. Handle some of these, then open /pending again.');
    } catch (error) {
      console.error('Pending reminder list error:', error);
      await ctx.reply('Could not load pending reminders. Please try again later.');
    }
  });

  bot.command('reminders', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    let patch: ReminderPreferencesPatch | undefined;
    if (args.length === 0) {
      patch = undefined;
    } else if (args.length === 2 && args[0] === 'quiet' && args[1] === 'off') {
      patch = { quietHoursStart: null, quietHoursEnd: null };
    } else if (args.length === 3 && args[0] === 'quiet') {
      patch = { quietHoursStart: args[1], quietHoursEnd: args[2] };
    } else if (args.length === 2 && args[0] === 'followups' && ['on', 'off'].includes(args[1])) {
      patch = { followUpsEnabled: args[1] === 'on' };
    } else {
      await ctx.reply(SETTINGS_USAGE);
      return;
    }
    try {
      const store = getStore();
      const current = await store.getReminderPreferences(userId);
      if (patch) {
        try {
          validateReminderPreferences({ ...current, ...patch });
        } catch {
          await ctx.reply('Quiet hours need two different times in 24-hour HH:MM format, for example /reminders quiet 22:00 08:00.');
          return;
        }
      }
      const preferences = patch ? await store.updateReminderPreferences(userId, patch) : current;
      await sendPreferences(ctx, preferences, timezone);
    } catch (error) {
      console.error('Reminder settings error:', error);
      await ctx.reply('Could not load or save reminder settings. Please try again later.');
    }
  });

  bot.action(/^occ:/, async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    const match = /^occ:(done|skip|10m|1h|tomorrow):(\d+):(\d+)$/.exec(data);
    const userId = ctx.from?.id;
    const id = Number(match?.[2]);
    const version = Number(match?.[3]);
    if (!match || !userId || !('message' in ctx.callbackQuery) || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(version) || version < 0) {
      await ctx.answerCbQuery('Invalid reminder action.', { show_alert: true });
      return;
    }
    try {
      const store = getStore();
      const current = await store.getReminderOccurrence(id, userId);
      if (!current || current.status !== 'pending' || current.version !== version) {
        await ctx.answerCbQuery('This reminder is no longer available or has changed. Open /pending for current controls.', { show_alert: true });
        return;
      }
      const action = match[1];
      const actionTime = now();
      const snoozedUntil = action === '10m' || action === '1h' || action === 'tomorrow'
        ? snoozeUntil(actionTime, action, timezone)
        : undefined;
      const updated = await store.actOnReminderOccurrence(id, userId, version, snoozedUntil ? 'snooze' : action as 'done' | 'skip', actionTime, snoozedUntil?.toISOString());
      if (!updated) {
        await ctx.answerCbQuery('This reminder has changed. Open /pending for current controls.', { show_alert: true });
        return;
      }
      try {
        await ctx.answerCbQuery(snoozedUntil
          ? `Snoozed until ${formatLocal(snoozedUntil, timezone)}. Quiet hours still apply.`
          : action === 'done' ? 'Marked done.' : 'Skipped this occurrence.');
      } catch (error) {
        console.error('Could not acknowledge saved reminder action:', error);
      }
      try {
        // Keep the full delivered text and touch only the card the user tapped.
        await ctx.editMessageReplyMarkup(occurrenceKeyboard(updated));
      } catch (error) {
        console.error('Could not refresh reminder buttons:', error);
      }
    } catch (error) {
      console.error('Reminder action error:', error);
      await ctx.answerCbQuery('Could not save that action. Please try again.', { show_alert: true });
    }
  });

  bot.action(/^reminderprefs:/, async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    const match = /^reminderprefs:(on|off|quietoff):(\d+)$/.exec(data);
    const userId = ctx.from?.id;
    if (!match || !userId || Number(match[2]) !== userId || !('message' in ctx.callbackQuery)) {
      await ctx.answerCbQuery('These settings belong to another user. Open /reminders for your settings.', { show_alert: true });
      return;
    }
    try {
      const store = getStore();
      const patch = match[1] === 'quietoff'
        ? { quietHoursStart: null, quietHoursEnd: null }
        : { followUpsEnabled: match[1] === 'on' };
      const preferences = await store.updateReminderPreferences(userId, patch);
      try {
        await ctx.answerCbQuery(match[1] === 'quietoff' ? 'Quiet hours off.' : `Follow-ups ${preferences.followUpsEnabled ? 'on' : 'off'}.`);
      } catch (error) {
        console.error('Could not acknowledge saved reminder settings:', error);
      }
      try {
        await ctx.editMessageText(preferencesMessage(preferences, timezone), { parse_mode: 'HTML', reply_markup: preferencesKeyboard(userId) });
      } catch (error) {
        // Repeated explicit ON/OFF actions may return Telegram's "not modified".
        if (!(error instanceof Error) || !error.message.includes('message is not modified')) {
          console.error('Could not refresh reminder settings:', error);
        }
      }
    } catch (error) {
      console.error('Reminder preference action error:', error);
      await ctx.answerCbQuery('Could not save reminder settings. Please try again.', { show_alert: true });
    }
  });
}
