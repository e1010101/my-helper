import { Telegraf, Context, Markup } from 'telegraf';
import { promptCommand, promptTextInputHandler, promptPhotoInputHandler, isUserInPromptFlow, cancelPromptFlow } from './prompt.js';
import { getPromptCommand, getPromptActionHandler } from './getprompt.js';
import { db, Task } from '../services/database.js';
import { escapeHtml } from '../utils/telegram-format.js';
import { splitTelegramHtml } from '../utils/telegram-chunk.js';
import { renderHelpText } from './catalog.js';
import type { AssistantStore } from '../services/assistant-store.js';
import { buildTodoCard, buildReminderCard, taskPreview } from '../utils/task-format.js';
import { ReminderControls } from './reminder-controls.js';

export { isUserInPromptFlow };

export interface BotCommand {
  command: string;
  description: string;
  handler: (ctx: Context) => Promise<void>;
}

// Admin user IDs - add your Telegram user ID here
// To find your user ID, message the bot and check the logs, or use a bot like @userinfobot
const ADMIN_USER_IDS = (process.env.ADMIN_USER_ID || '')
  .split(',')
  .map((id) => Number.parseInt(id.trim(), 10))
  .filter((id) => Number.isInteger(id) && id > 0);

const TASK_LIST_LIMIT = 20;

type TaskField = 'name' | 'description';

interface TaskDraft {
  chatId: number;
  messageId?: number;
  taskId?: number;
  name?: string;
  description?: string;
  awaiting?: TaskField;
  saving?: boolean;
}

const taskDrafts = new Map<number, TaskDraft>();

function isMissingTasksTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeCode = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const maybeMessage = 'message' in error ? String((error as { message?: unknown }).message || '') : '';

  return maybeCode === 'PGRST205' && maybeMessage.includes('public.tasks');
}

function isAdmin(userId: number | undefined): boolean {
  return userId !== undefined && ADMIN_USER_IDS.includes(userId);
}

/** Telegram rejects messages longer than 4096 characters. */
function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * Renders a task list message plus its controls. Task text is escaped
 * because it is user-supplied and the message is sent with parse_mode HTML.
 */
function buildTaskListPayload(tasks: Task[], timezone: string) {
  return tasks.map((task) => buildTodoCard(task, timezone));
}

function parseTaskId(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

interface TaskCommandOptions {
  getStore: () => AssistantStore;
  timezone: string;
}

export function registerCommands(bot: Telegraf, options: TaskCommandOptions): void {
  const reminderControls = new ReminderControls(options.getStore, options.timezone, (userId) => {
    taskDrafts.delete(userId);
    cancelPromptFlow(userId);
  });
  // Import and register all commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('ping', pingCommand);
  bot.command('task', (ctx) => {
    if (ctx.from && /\s-(create|update)\b/.test(ctx.message.text)) {
      reminderControls.clearDraft(ctx.from.id);
      cancelPromptFlow(ctx.from.id);
    }
    return taskCommand(ctx, options);
  });
  bot.command('tasks', (ctx) => tasksCommand(ctx, options));
  bot.command('prompt', (ctx) => {
    if (ctx.from) {
      taskDrafts.delete(ctx.from.id);
      reminderControls.clearDraft(ctx.from.id);
    }
    return promptCommand(ctx);
  });
  bot.command('getprompt', getPromptCommand);
  bot.action(/^getprompt:(next|prev)$/, getPromptActionHandler);
  bot.action(/^task:(set_name|set_description|submit|cancel)$/, taskActionCommand);
  bot.action(/^task:(complete|reopen|toggle):(\d+)$/, (ctx) => setTaskStatusActionCommand(ctx, options));
  bot.action(/^task:(edit|delete|confirm_delete|cancel_delete):(\d+)$/, (ctx) => taskListActionCommand(ctx, options, reminderControls));
  bot.action(/^reminder:(edit|delete|confirm_delete|cancel_delete|text|schedule|save|cancel):(\d+)$/, (ctx) => reminderControls.handleAction(ctx));
  // Multi-step form input. Prompt drafts and task drafts are tracked in
  // separate maps, so only one of these handlers consumes the message.
  bot.on('text', async (ctx, next) => {
    if (await reminderControls.handleText(ctx)) return;
    if (await taskTextInputHandler(ctx)) return;
    if (await promptTextInputHandler(ctx)) return;
    await next();
  });
  bot.on('photo', async (ctx, next) => {
    await promptPhotoInputHandler(ctx);
    await next();
  });
  bot.command('status', statusCommand);
  bot.command('stats', statsCommand);
}

async function startCommand(ctx: Context) {
  const firstName = ctx.from?.first_name || 'there';
  await ctx.reply(
    `👋 Hello ${escapeHtml(firstName)}! I'm your personal helper bot.\n\n` +
    `I can help you with various tasks. Use /help to see available commands.`
  );
}

async function helpCommand(ctx: Context) {
  const userId = ctx.from?.id;
  const isAdminUser = isAdmin(userId);

  // Rendered from the catalog so the help text and Telegram's command menu
  // cannot disagree about what exists.
  await ctx.reply(renderHelpText(isAdminUser), { parse_mode: 'Markdown' });
}

async function pingCommand(ctx: Context) {
  const start = Date.now();
  await ctx.reply('🏓 Pong!').then(() => {
    const latency = Date.now() - start;
    ctx.reply(`⚡ Response time: ${latency}ms`);
  });
}

function getTaskFormKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Name', 'task:set_name'),
      Markup.button.callback('Description', 'task:set_description'),
    ],
    [Markup.button.callback('Submit', 'task:submit'), Markup.button.callback('Cancel', 'task:cancel')],
  ]);
}

function getTaskFormText(draft: TaskDraft): string {
  const name = draft.name?.trim() ? escapeHtml(truncate(draft.name.trim(), 200)) : '(not set)';
  const description = draft.description?.trim() ? escapeHtml(truncate(draft.description.trim(), 800)) : '(not set)';
  const awaitingText = draft.awaiting
    ? `\n\nWaiting for ${draft.awaiting} input...`
    : '\n\nTap Name or Description to edit, then tap Submit.';

  const title = draft.taskId ? `Edit To-do [ID: ${draft.taskId}]` : 'New Task Form';
  return `📝 <b>${title}</b>\n\n<b>Name:</b> ${name}\n<b>Description:</b> ${description}${awaitingText}`;
}

async function renderTaskForm(ctx: Context, userId: number, draft: TaskDraft): Promise<void> {
  const text = getTaskFormText(draft);
  const keyboard = getTaskFormKeyboard().reply_markup;

  if (draft.messageId) {
    try {
      await ctx.telegram.editMessageText(draft.chatId, draft.messageId, undefined, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    } catch (error) {
      console.error('Error editing task form message:', error);
    }
  }

  const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  draft.chatId = sent.chat.id;
  draft.messageId = sent.message_id;
  taskDrafts.set(userId, draft);
}

async function taskCommand(ctx: Context, options: TaskCommandOptions) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

  if (!userId || !chatId) {
    await ctx.reply('❌ Could not identify user');
    return;
  }

  // Parse command arguments: /task -(flag) (id)
  const args = text.split(' ').slice(1);
  const flag = args[0]?.toLowerCase();

  if (!flag) {
    await ctx.reply('❌ Please specify an action. Usage:\n`/task -create`\n`/task -read <id>`\n`/task -update <id>`\n`/task -delete <id>`', { parse_mode: 'Markdown' });
    return;
  }

  const idParam = parseTaskId(args[1]);

  try {
    if (flag === '-read') {
      if (args[1]?.toLowerCase() === 'all') {
        await tasksCommand(ctx, options);
        return;
      }

      if (idParam === null) {
        await ctx.reply('❌ Please provide a valid task ID: `/task -read <id>` or `/task -read all`', { parse_mode: 'Markdown' });
        return;
      }

      const task = await db.getTask(idParam, userId);
      if (!task) {
        await ctx.reply('❌ Task not found.');
        return;
      }

      const status = task.completed ? '✅ Completed' : '⬜ Pending';
      const createdAt = new Date(task.created_at).toLocaleString();
      const details =
        `📖 <b>Task Details (ID: ${task.id})</b>\n\n` +
        `<b>Name:</b> ${escapeHtml(task.name)}\n` +
        `<b>Description:</b> ${escapeHtml(task.description ?? '')}\n` +
        `<b>Status:</b> ${status}\n` +
        `<b>Created:</b> ${createdAt}`;
      for (const chunk of splitTelegramHtml(details)) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
      return;
    }

    if (flag === '-delete') {
      if (idParam === null) {
        await ctx.reply('❌ Please provide a valid task ID: `/task -delete <id>`', { parse_mode: 'Markdown' });
        return;
      }

      const task = await db.getTask(idParam, userId);
      if (!task) {
        await ctx.reply('❌ Task not found.');
        return;
      }

      await db.deleteTask(idParam, userId);
      await ctx.reply(`🗑️ Task deleted!`);
      return;
    }

    if (flag === '-update') {
      if (idParam === null) {
        await ctx.reply('❌ Please provide a valid task ID: `/task -update <id>`', { parse_mode: 'Markdown' });
        return;
      }

      const task = await db.getTask(idParam, userId);
      if (!task) {
        await ctx.reply('❌ Task not found.');
        return;
      }

      const draft: TaskDraft = { chatId, taskId: task.id, name: task.name, description: task.description };
      taskDrafts.set(userId, draft);
      await renderTaskForm(ctx, userId, draft);
      return;
    }

    if (flag === '-create') {
      const draft: TaskDraft = { chatId };
      taskDrafts.set(userId, draft);
      await renderTaskForm(ctx, userId, draft);
      return;
    }

    // Unrecognized flag
    await ctx.reply('❌ Unrecognized action. Usage:\n`/task -create`\n`/task -read <id>`\n`/task -update <id>`\n`/task -delete <id>`', { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Task command error:', error);
    await ctx.reply('❌ An error occurred processing your task request. Please try again.');
  }
}

async function tasksCommand(ctx: Context, options: TaskCommandOptions) {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Could not identify user');
    return;
  }

  // A cron created through the assistant is a reminder, not a todo. Read both
  // sources independently so an unavailable table cannot hide the other list.
  const [tasksResult, remindersResult] = await Promise.allSettled([
    db.getTasksByUser(userId, TASK_LIST_LIMIT),
    options.getStore().listReminders(userId),
  ]);

  if (tasksResult.status === 'fulfilled' && remindersResult.status === 'fulfilled'
    && tasksResult.value.length === 0 && remindersResult.value.length === 0) {
    await ctx.reply('📝 You have no todos or active reminders yet. Use /task -create to create a todo, or ask me to set a reminder.\n\nOpen /pending for reminders waiting for Done, Snooze or Skip, including delivered one-off reminders.');
    return;
  }

  if (tasksResult.status === 'fulfilled') {
    if (tasksResult.value.length > 0) {
      await ctx.reply(`📝 <b>Your To-dos (${tasksResult.value.length})</b>`, { parse_mode: 'HTML' });
      for (const { text, reply_markup } of buildTaskListPayload(tasksResult.value, options.timezone)) {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup });
      }
    }
  } else {
    console.error('Tasks command error:', tasksResult.reason);
    await ctx.reply(isMissingTasksTableError(tasksResult.reason)
      ? '❌ Cannot list todos: database table "tasks" is missing. Run docs/database-schema.sql in Supabase SQL Editor.'
      : '❌ Failed to fetch todos. Please try again later.');
  }

  if (remindersResult.status === 'fulfilled') {
    const reminders = remindersResult.value;
    await ctx.reply(`⏰ <b>Active reminders (${reminders.length})</b>`, { parse_mode: 'HTML' });
    for (const reminder of reminders) {
      const { text, reply_markup } = buildReminderCard(reminder, options.timezone);
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup });
    }
  } else {
    console.error('Tasks reminder list error:', remindersResult.reason);
    await ctx.reply('❌ Failed to fetch active reminders. Please try again later.');
  }
  await ctx.reply('Open /pending for reminders waiting for Done, Snooze or Skip. Configure quiet hours and opt-in follow-ups with /reminders.');
}

async function taskActionCommand(ctx: Context) {
  const userId = ctx.from?.id;
  const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
  const callbackMessage = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
  const callbackChatId = callbackMessage?.chat?.id;
  const callbackMessageId = callbackMessage?.message_id;

  if (!userId || !callbackData || !callbackChatId) {
    await ctx.answerCbQuery();
    return;
  }

  const draft = taskDrafts.get(userId);
  if (!draft || draft.chatId !== callbackChatId || draft.messageId !== callbackMessageId) {
    await ctx.answerCbQuery('This form is no longer active. Open /tasks and tap Edit again.', { show_alert: true });
    return;
  }
  if (draft.saving) {
    await ctx.answerCbQuery('Saving…');
    return;
  }
  if (callbackData === 'task:cancel') {
    taskDrafts.delete(userId);
    await ctx.answerCbQuery('Edit cancelled');
    await ctx.editMessageText('Task form cancelled.', { reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (callbackData === 'task:set_name' || callbackData === 'task:set_description') {
    draft.awaiting = callbackData === 'task:set_name' ? 'name' : 'description';
    taskDrafts.set(userId, draft);
    await ctx.answerCbQuery(`Send the task ${draft.awaiting} as your next message.`);
    await renderTaskForm(ctx, userId, draft);
    return;
  }

  if (callbackData !== 'task:submit') {
    await ctx.answerCbQuery();
    return;
  }

  if (draft.awaiting || !draft.name?.trim() || !draft.description?.trim()) {
    await ctx.answerCbQuery('Please fill in Name and Description before submitting.', {
      show_alert: true,
    });
    return;
  }

  draft.saving = true;
  const name = draft.name.trim();
  const description = draft.description.trim();
  let confirmation: string;

  try {
    if (draft.taskId) {
      if (!await db.getTask(draft.taskId, userId)) {
        taskDrafts.delete(userId);
        await ctx.answerCbQuery('This to-do no longer exists.', { show_alert: true });
        return;
      }
      await db.updateTask(draft.taskId, userId, name, description);
      confirmation = `✏️ <b>Task (ID: ${draft.taskId}) updated!</b>\n\n<b>Name:</b> ${taskPreview(name, 200)}\n<b>Description:</b> ${taskPreview(description)}`;
    } else {
      await db.createTask(userId, name, description);
      confirmation = `✅ <b>Task created!</b>\n\n<b>Name:</b> ${taskPreview(name, 200)}\n<b>Description:</b> ${taskPreview(description)}`;
    }
  } catch (error) {
    draft.saving = false;
    console.error('Task submit error:', error);
    const missingTasksTable = isMissingTasksTableError(error);
    try {
      await ctx.answerCbQuery(
        missingTasksTable ? 'Tasks table is missing in database' : 'Failed to save task',
        { show_alert: true }
      );
    } catch (callbackError) {
      console.warn('Failed to answer callback query after task submit error:', callbackError);
    }
    if (missingTasksTable) {
      await ctx.reply(
        '❌ Failed to save task: database table "tasks" is missing. Run docs/database-schema.sql in Supabase SQL Editor.'
      );
      return;
    }
    await ctx.reply('❌ Failed to save task. Please try again later.');
    return;
  }

  // Once persistence succeeds, this draft must never be submitted again even
  // if Telegram cannot deliver either the edited card or its fallback reply.
  if (taskDrafts.get(userId) === draft) taskDrafts.delete(userId);
  try {
    if (draft.messageId) {
      await ctx.telegram.editMessageText(draft.chatId, draft.messageId, undefined, confirmation, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      await ctx.reply(confirmation, { parse_mode: 'HTML' });
    }
  } catch (error) {
    console.error('Task saved but confirmation message failed:', error);
    await ctx.reply(confirmation, { parse_mode: 'HTML' }).catch((replyError) => {
      console.warn('Task saved but fallback confirmation failed:', replyError);
    });
  }
  try {
    await ctx.answerCbQuery('Task saved');
  } catch (callbackError) {
    console.warn('Task saved but failed to answer callback query:', callbackError);
  }
}

async function setTaskStatusActionCommand(ctx: Context, options: TaskCommandOptions) {
  const userId = ctx.from?.id;
  const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
  // Older cards used a toggle without a target state. Refresh those cards so
  // a stale "Complete" button cannot accidentally reopen a completed task.
  const action = callbackData.split(':')[1];
  const taskId = parseTaskId(callbackData.split(':')[2]);

  if (!userId || taskId === null) {
    await ctx.answerCbQuery('Invalid task ID', { show_alert: true });
    return;
  }

  try {
    const task = await db.getTask(taskId, userId);
    if (!task) {
      await ctx.answerCbQuery('Task not found', { show_alert: true });
      return;
    }

    const newStatus = action === 'toggle' ? task.completed : action === 'complete';
    if (newStatus !== task.completed) {
      await db.updateTaskStatus(taskId, userId, newStatus);
    }

    const { text, reply_markup } = buildTodoCard({ ...task, completed: newStatus }, options.timezone);

    if (ctx.callbackQuery?.message && 'chat' in ctx.callbackQuery.message) {
      await ctx.telegram.editMessageText(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        text,
        { parse_mode: 'HTML', reply_markup }
      ).catch((error: unknown) => {
        if (!/message is not modified/i.test(String(error))) throw error;
      });
    }

    await ctx.answerCbQuery(action === 'toggle'
      ? 'Card refreshed. Tap Complete or Reopen.'
      : `Task marked as ${newStatus ? 'completed' : 'uncompleted'}`);
  } catch (error) {
    console.error('Task status update error:', error);
    await ctx.answerCbQuery('Failed to update task', { show_alert: true });
  }
}

async function taskTextInputHandler(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';

  if (!userId || !text || text.startsWith('/')) {
    return false;
  }

  const draft = taskDrafts.get(userId);
  if (!draft || ctx.chat?.id !== draft.chatId) {
    return false;
  }
  if (draft.saving || !draft.awaiting) {
    await ctx.reply('Use the Name or Description button to choose a field, or tap Submit / Cancel.');
    return true;
  }

  const updatedField: TaskField = draft.awaiting;
  if (updatedField === 'name') {
    draft.name = text;
  } else {
    draft.description = text;
  }

  draft.awaiting = undefined;
  taskDrafts.set(userId, draft);
  await renderTaskForm(ctx, userId, draft);
  return true;
}

async function taskListActionCommand(ctx: Context, options: TaskCommandOptions, reminderControls: ReminderControls): Promise<void> {
  const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
  const match = /^task:(edit|delete|confirm_delete|cancel_delete):(\d+)$/.exec(data);
  const userId = ctx.from?.id;
  const taskId = Number(match?.[2]);
  if (!match || !userId || !ctx.chat || !Number.isSafeInteger(taskId) || taskId < 1) {
    await ctx.answerCbQuery('Invalid task ID', { show_alert: true });
    return;
  }
  try {
    const task = await db.getTask(taskId, userId);
    if (!task) {
      await ctx.answerCbQuery('Task not found', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    if (match[1] === 'edit') {
      reminderControls.clearDraft(userId);
      cancelPromptFlow(userId);
      const draft: TaskDraft = { chatId: ctx.chat.id, taskId: task.id, name: task.name, description: task.description };
      taskDrafts.set(userId, draft);
      await renderTaskForm(ctx, userId, draft);
    } else if (match[1] === 'delete') {
      await ctx.editMessageText(`🗑 <b>Delete To-do [ID: ${taskId}]?</b>\n\n${taskPreview(task.name, 200)}`, {
        parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('Confirm delete', `task:confirm_delete:${taskId}`), Markup.button.callback('Keep to-do', `task:cancel_delete:${taskId}`)],
        ]).reply_markup,
      });
    } else if (match[1] === 'confirm_delete') {
      await db.deleteTask(taskId, userId);
      if (taskDrafts.get(userId)?.taskId === taskId) taskDrafts.delete(userId);
      await ctx.editMessageText(`🗑 To-do [ID: ${taskId}] deleted.`, { reply_markup: { inline_keyboard: [] } });
    } else {
      const card = buildTodoCard(task, options.timezone);
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', reply_markup: card.reply_markup });
    }
  } catch (error) {
    console.error('Task list action error:', error);
    await ctx.reply('❌ Could not update this to-do. Please try again.');
  }
}

async function statusCommand(ctx: Context) {
  const userId = ctx.from?.id;

  if (!isAdmin(userId)) {
    await ctx.reply('❌ This command is only available to administrators');
    return;
  }

  try {
    const { getHealthService } = await import('../bot.js');
    const healthService = getHealthService();

    if (!healthService) {
      await ctx.reply('❌ Health service not available');
      return;
    }

    const health = await healthService.getHealthStatus();

    const statusEmoji = health.status === 'healthy' ? '✅' : '❌';
    const botEmoji = health.bot.connected ? '✅' : '❌';
    const dbEmoji = health.database.connected ? '✅' : '❌';

    const statusText = `
${statusEmoji} <b>Bot Status</b>

<b>Uptime:</b> ${healthService.formatUptime()}
<b>Status:</b> ${health.status.toUpperCase()}

<b>Components:</b>
${botEmoji} Bot: ${health.bot.connected ? 'Connected' : 'Disconnected'} (${health.bot.mode})
${dbEmoji} Database: ${health.database.connected ? 'Connected' : 'Disconnected'}${health.database.latency ? ` (${health.database.latency}ms)` : ''}${health.database.error ? `\n⚠️ DB Error: ${escapeHtml(health.database.error)}` : ''}

<b>System:</b>
💾 Memory: ${health.system.memory.used}MB / ${health.system.memory.total}MB (${health.system.memory.percentage}%)
🖥️ Platform: ${health.system.platform}
⚙️ Node: ${health.system.nodeVersion}

<b>Last Check:</b> ${new Date(health.timestamp).toLocaleString()}
    `;

    await ctx.reply(statusText, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Status command error:', error);
    await ctx.reply('❌ Failed to retrieve status');
  }
}

async function statsCommand(ctx: Context) {
  const userId = ctx.from?.id;

  if (!isAdmin(userId)) {
    await ctx.reply('❌ This command is only available to administrators');
    return;
  }

  try {
    // Get command statistics
    const { data: recentCommands, error: recentError } = await db.getClient()
      .from('command_history')
      .select('command, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (recentError) throw recentError;

    // Count commands
    const commandCounts: Record<string, number> = {};
    recentCommands?.forEach(cmd => {
      commandCounts[cmd.command] = (commandCounts[cmd.command] || 0) + 1;
    });

    // Get top commands
    const topCommands = Object.entries(commandCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Get total users
    const { count: totalUsers } = await db.getClient()
      .from('user_data')
      .select('*', { count: 'exact', head: true });

    // Get total commands
    const { count: totalCommands } = await db.getClient()
      .from('command_history')
      .select('*', { count: 'exact', head: true });

    let statsText = `
📊 <b>Usage Statistics</b>

<b>Overall:</b>
👥 Total Users: ${totalUsers || 0}
📝 Total Commands: ${totalCommands || 0}

<b>Top Commands (last 100):</b>
`;

    topCommands.forEach(([cmd, count], index) => {
      statsText += `${index + 1}. ${escapeHtml(cmd)}: ${count}×\n`;
    });

    await ctx.reply(statsText, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Stats command error:', error);
    await ctx.reply('❌ Failed to retrieve statistics');
  }
}
