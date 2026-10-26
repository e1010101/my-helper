import { Markup } from 'telegraf';
import type { Task } from '../services/database.js';
import type { Reminder } from '../types/assistant.js';
import { formatLocal, WEEKDAY_NAMES } from '../services/reminder-time.js';
import { escapeHtml } from './telegram-format.js';

/** Bound previews before escaping so each card fits one Telegram message. */
export function taskPreview(text: string, limit = 800): string {
  return escapeHtml(text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…`);
}

function localDate(iso: string | null, timezone: string): string {
  return iso ? escapeHtml(formatLocal(new Date(iso), timezone)) : 'Never';
}

export function reminderSchedule(reminder: Reminder): string {
  const at = reminder.timeOfDay ? ` at ${reminder.timeOfDay}` : '';
  if (reminder.frequency === 'daily') return `Every day${at} (daily)`;
  if (reminder.frequency === 'weekly') return `Every ${WEEKDAY_NAMES[reminder.dayOfWeek ?? 0]}${at} (weekly)`;
  if (reminder.frequency === 'monthly') return `Day ${reminder.dayOfMonth ?? 1} of every month${at} (monthly)`;
  return 'One-off';
}

export function buildTodoCard(task: Task, timezone: string) {
  return {
    text: `📝 <b>To-do [ID: ${task.id}]</b>\n\n`
      + `<b>Name:</b> ${taskPreview(task.name, 200)}\n`
      + `<b>Description:</b> ${taskPreview(task.description ?? '')}\n`
      + `<b>Status:</b> ${task.completed ? '✅ Completed' : '⬜ Pending'}\n`
      + `<b>Created:</b> ${localDate(task.created_at, timezone)} (${escapeHtml(timezone)})`,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback(task.completed ? '⬜ Reopen' : '✅ Complete', `task:${task.completed ? 'reopen' : 'complete'}:${task.id}`)],
      [Markup.button.callback('✏️ Edit', `task:edit:${task.id}`), Markup.button.callback('🗑 Delete', `task:delete:${task.id}`)],
    ]).reply_markup,
  };
}

export function buildReminderCard(reminder: Reminder, timezone: string) {
  return {
    text: `⏰ <b>Reminder [ID: ${reminder.id}]</b>\n\n`
      + `<b>Text:</b> ${taskPreview(reminder.text)}\n`
      + `<b>Status:</b> ${reminder.active ? 'Active' : 'Cancelled'}\n`
      + `<b>Schedule:</b> ${escapeHtml(reminderSchedule(reminder))}\n`
      + `<b>Next run:</b> ${localDate(reminder.nextRunAt, timezone)} (${escapeHtml(timezone)})\n`
      + `<b>Created:</b> ${localDate(reminder.createdAt, timezone)}\n`
      + `<b>Last sent:</b> ${localDate(reminder.lastSentAt, timezone)}`,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit', `reminder:edit:${reminder.id}`), Markup.button.callback('🗑 Delete', `reminder:delete:${reminder.id}`)],
    ]).reply_markup,
  };
}
