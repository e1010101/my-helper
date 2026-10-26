import { Markup, type Context } from 'telegraf';
import type { AssistantStore } from '../services/assistant-store.js';
import type { Reminder, ReminderUpdate } from '../types/assistant.js';
import { parseNaturalTime, parseClockTime, nextOccurrence, formatLocal, type ParsedTime } from '../services/reminder-time.js';
import { escapeHtml } from '../utils/telegram-format.js';
import { buildReminderCard, reminderSchedule, taskPreview } from '../utils/task-format.js';

const EDIT_TTL_MS = 10 * 60_000;
interface ReminderDraft {
  reminder: Reminder;
  chatId: number;
  messageId: number;
  text: string;
  schedule?: ReminderUpdate['schedule'];
  awaiting?: 'text' | 'schedule';
  expiresAt: number;
  saving?: boolean;
}

function parseEditedSchedule(text: string, now: Date, timezone: string): ParsedTime | null {
  const monthly = /^every month on (?:day )?(\d{1,2}) at (.+)$/i.exec(text);
  if (monthly) {
    const dayOfMonth = Number(monthly[1]);
    const clock = parseClockTime(monthly[2]);
    if (dayOfMonth < 1 || dayOfMonth > 31 || !clock) return null;
    const timeOfDay = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
    const date = nextOccurrence({ timeOfDay, dayOfMonth }, now, timezone);
    return date ? { date, recurrence: { frequency: 'monthly', timeOfDay, dayOfMonth } } : null;
  }
  // The shared parser resolves datetimes without offsets in this timezone and
  // rejects weekday sets, which the reminder schema cannot represent.
  return parseNaturalTime(text, now, timezone);
}

/** Per-bot editor state; data is persisted only when the user taps Save. */
export class ReminderControls {
  private drafts = new Map<number, ReminderDraft>();

  constructor(
    private getStore: () => AssistantStore,
    private timezone: string,
    private onEditStart: (userId: number) => void,
    private now: () => Date = () => new Date()
  ) {}

  clearDraft(userId: number): void {
    this.drafts.delete(userId);
  }

  private getDraft(userId: number): ReminderDraft | undefined {
    const draft = this.drafts.get(userId);
    if (draft && draft.expiresAt > this.now().getTime()) return draft;
    this.drafts.delete(userId);
    return undefined;
  }

  private form(draft: ReminderDraft) {
    const preview = { ...draft.reminder, ...draft.schedule };
    return {
      text: `✏️ <b>Edit Reminder [ID: ${draft.reminder.id}]</b>\n\n`
        + `<b>Text:</b> ${taskPreview(draft.text)}\n`
        + `<b>Schedule:</b> ${escapeHtml(reminderSchedule(preview))}\n`
        + `<b>Next run:</b> ${escapeHtml(formatLocal(new Date(preview.nextRunAt), this.timezone))} (${escapeHtml(this.timezone)})\n\n`
        + (draft.awaiting ? `Send the new ${draft.awaiting} as your next message.` : 'Tap Text or Schedule to edit, then Save to apply changes.'),
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('Text', `reminder:text:${draft.reminder.id}`), Markup.button.callback('Schedule', `reminder:schedule:${draft.reminder.id}`)],
        [Markup.button.callback('✅ Save', `reminder:save:${draft.reminder.id}`), Markup.button.callback('Cancel', `reminder:cancel:${draft.reminder.id}`)],
      ]).reply_markup,
    };
  }

  private async renderForm(ctx: Context, draft: ReminderDraft): Promise<void> {
    const payload = this.form(draft);
    try {
      await ctx.telegram.editMessageText(draft.chatId, draft.messageId, undefined, payload.text, { parse_mode: 'HTML', reply_markup: payload.reply_markup });
    } catch (error) {
      console.error('Failed to render reminder form:', error);
      // Keep the buttons tied to the new form message if the original vanished.
      const sent = await ctx.reply(payload.text, { parse_mode: 'HTML', reply_markup: payload.reply_markup });
      draft.chatId = sent.chat.id;
      draft.messageId = sent.message_id;
    }
  }

  async handleText(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
    if (!userId || !text || text.startsWith('/')) return false;
    const draft = this.getDraft(userId);
    if (!draft || ctx.chat?.id !== draft.chatId) return false;
    if (draft.saving || !draft.awaiting) {
      await ctx.reply('Use the Text or Schedule button to choose a field, or tap Save / Cancel.');
      return true;
    }
    if (draft.awaiting === 'text') {
      draft.text = text;
    } else {
      if (/^every\s+weekdays?\b/i.test(text)) {
        await ctx.reply('Weekday-only schedules are not supported yet. Use a daily schedule or create a separate weekly reminder for each weekday.');
        return true;
      }
      const parsed = parseEditedSchedule(text, this.now(), this.timezone);
      if (!parsed || !Number.isFinite(parsed.date.getTime()) || parsed.date.getTime() <= this.now().getTime()) {
        await ctx.reply('Please use a future schedule, such as "every day at 22:00", "every Monday at 09:00", "every month on day 15 at 09:00", or "tomorrow at 10:00".');
        return true;
      }
      draft.schedule = {
        nextRunAt: parsed.date.toISOString(),
        frequency: parsed.recurrence?.frequency ?? 'once',
        timeOfDay: parsed.recurrence?.timeOfDay ?? null,
        dayOfWeek: parsed.recurrence?.dayOfWeek ?? null,
        dayOfMonth: parsed.recurrence?.dayOfMonth ?? null,
      };
    }
    draft.awaiting = undefined;
    await this.renderForm(ctx, draft);
    return true;
  }

  async handleAction(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    const match = /^reminder:(edit|delete|confirm_delete|cancel_delete|text|schedule|save|cancel):(\d+)$/.exec(data);
    const userId = ctx.from?.id;
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    const id = Number(match?.[2]);
    if (!match || !userId || !message || !Number.isSafeInteger(id) || id < 1) {
      await ctx.answerCbQuery('Invalid reminder', { show_alert: true });
      return;
    }
    const action = match[1];
    try {
      if (['text', 'schedule', 'save', 'cancel'].includes(action)) {
        const draft = this.getDraft(userId);
        if (!draft || draft.reminder.id !== id || draft.messageId !== message.message_id || draft.chatId !== message.chat.id) {
          await ctx.answerCbQuery('This edit form expired. Open /tasks and tap Edit again.', { show_alert: true });
          return;
        }
        if (draft.saving) {
          await ctx.answerCbQuery('Saving…');
          return;
        }
        if (action === 'text' || action === 'schedule') {
          draft.awaiting = action;
          await ctx.answerCbQuery();
          await this.renderForm(ctx, draft);
          if (action === 'schedule') await ctx.reply(`Send a schedule in ${this.timezone}, e.g. "every day at 22:00" or "every Monday at 09:00".`);
          return;
        }
        if (action === 'cancel') {
          this.clearDraft(userId);
          await ctx.answerCbQuery('Edit cancelled');
          await ctx.editMessageText(`Edit cancelled for Reminder [ID: ${id}].`, { reply_markup: { inline_keyboard: [] } });
          return;
        }
        if (draft.awaiting) {
          await ctx.answerCbQuery('Finish entering the selected field before saving.', { show_alert: true });
          return;
        }
        if (draft.schedule && new Date(draft.schedule.nextRunAt) <= this.now()) {
          await ctx.answerCbQuery('The proposed time has passed. Set a future schedule.', { show_alert: true });
          return;
        }
        draft.saving = true;
        await ctx.answerCbQuery().catch(() => undefined);
        let updated: Reminder | null;
        try {
          updated = await this.getStore().updateReminder(id, userId, { text: draft.text, schedule: draft.schedule });
        } catch (error) {
          draft.saving = false;
          throw error;
        }
        this.clearDraft(userId);
        if (!updated) {
          await ctx.editMessageText('This reminder is no longer active. Open /tasks to refresh.', { reply_markup: { inline_keyboard: [] } });
          return;
        }
        const card = buildReminderCard(updated, this.timezone);
        try {
          await ctx.editMessageText(`✅ Saved\n\n${card.text}`, { parse_mode: 'HTML', reply_markup: card.reply_markup });
        } catch (error) {
          console.error('Reminder saved but form refresh failed:', error);
          await ctx.reply(`✅ Reminder [ID: ${id}] saved. Open /tasks to see the updated details.`);
        }
        return;
      }

      const reminder = await this.getStore().getReminder(id, userId);
      if (!reminder) {
        await ctx.answerCbQuery('Reminder not found or no longer active', { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();
      if (action === 'edit') {
        this.onEditStart(userId);
        const draft: ReminderDraft = {
          reminder, text: reminder.text, chatId: message.chat.id,
          messageId: message.message_id, expiresAt: this.now().getTime() + EDIT_TTL_MS,
        };
        this.drafts.set(userId, draft);
        await this.renderForm(ctx, draft);
      } else if (action === 'delete') {
        await ctx.editMessageText(`🗑 <b>Delete Reminder [ID: ${id}]?</b>\n\n${taskPreview(reminder.text)}\n\nThis stops future runs of this reminder.`, {
          parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('Confirm delete', `reminder:confirm_delete:${id}`), Markup.button.callback('Keep reminder', `reminder:cancel_delete:${id}`)],
          ]).reply_markup,
        });
      } else if (action === 'confirm_delete') {
        const cancelled = await this.getStore().cancelReminder(id, userId);
        if (this.getDraft(userId)?.reminder.id === id) this.clearDraft(userId);
        await ctx.editMessageText(cancelled ? `🗑 Reminder [ID: ${id}] deleted. Future runs stopped.` : 'This reminder is no longer active.', { reply_markup: { inline_keyboard: [] } });
      } else {
        const card = buildReminderCard(reminder, this.timezone);
        await ctx.editMessageText(card.text, { parse_mode: 'HTML', reply_markup: card.reply_markup });
      }
    } catch (error) {
      console.error('Reminder controls error:', error);
      await ctx.reply('❌ Could not update the reminder. If you were editing, your draft is kept so you can retry Save.');
    }
  }
}
