import { Telegraf, Context, Markup } from 'telegraf';
import { promptCommand, promptTextInputHandler, promptPhotoInputHandler, isUserInPromptFlow } from './prompt.js';

export { isUserInPromptFlow };

export interface BotCommand {
  command: string;
  description: string;
  handler: (ctx: Context) => Promise<void>;
}

// Admin user IDs - add your Telegram user ID here
// To find your user ID, message the bot and check the logs, or use a bot like @userinfobot
const ADMIN_USER_IDS = [parseInt(process.env.ADMIN_USER_ID || '0')];
type TaskField = 'name' | 'description';

interface TaskDraft {
  chatId: number;
  messageId?: number;
  taskId?: number;
  name?: string;
  description?: string;
  awaiting?: TaskField;
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

export function registerCommands(bot: Telegraf): void {
  // Import and register all commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('ping', pingCommand);
  bot.command('task', taskCommand);
  bot.command('tasks', tasksCommand);
  bot.command('prompt', promptCommand);
  bot.action(/^task:(set_name|set_description|submit)$/, taskActionCommand);
  bot.action(/^task:toggle:(\d+)$/, toggleTaskActionCommand);
  bot.on('text', async (ctx, next) => {
    const promptHandled = await promptTextInputHandler(ctx);
    if (!promptHandled) {
      await taskTextInputHandler(ctx);
    }
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
    `👋 Hello ${firstName}! I'm your personal helper bot.\n\n` +
    `I can help you with various tasks. Use /help to see available commands.`
  );
}

async function helpCommand(ctx: Context) {
  const userId = ctx.from?.id;
  const isAdminUser = isAdmin(userId);

  let helpText = `
🤖 *Available Commands:*

/start - Start the bot and see welcome message
/help - Show this help message
/ping - Check if the bot is responsive
/task - Create a new to-do task (or use flags)
  \`-create\` : Create a task
  \`-read <id>\` : View task details (\`all\` to list all)
  \`-update <id>\` : Edit a task
  \`-delete <id>\` : Delete a task
/tasks - List your saved tasks
/prompt - Create and save a new prompt template
`;

  if (isAdminUser) {
    helpText += `
*Admin Commands:*
/status - Check bot health and uptime
/stats - View usage statistics
`;
  }

  helpText += `\n_More commands coming soon!_`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
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
    [Markup.button.callback('Submit', 'task:submit')],
  ]);
}

function getTaskFormText(draft: TaskDraft): string {
  const name = draft.name?.trim() || '(not set)';
  const description = draft.description?.trim() || '(not set)';
  const awaitingText = draft.awaiting
    ? `\n\nWaiting for ${draft.awaiting} input...`
    : '\n\nTap Name or Description to edit, then tap Submit.';

  return `📝 New Task Form\n\nName: ${name}\nDescription: ${description}${awaitingText}`;
}

async function renderTaskForm(ctx: Context, userId: number, draft: TaskDraft): Promise<void> {
  const text = getTaskFormText(draft);
  const keyboard = getTaskFormKeyboard().reply_markup;

  if (draft.messageId) {
    try {
      await ctx.telegram.editMessageText(draft.chatId, draft.messageId, undefined, text, {
        reply_markup: keyboard,
      });
      return;
    } catch (error) {
      console.error('Error editing task form message:', error);
    }
  }

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  draft.chatId = sent.chat.id;
  draft.messageId = sent.message_id;
  taskDrafts.set(userId, draft);
}

async function taskCommand(ctx: Context) {
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

  const idParam = parseInt(args[1], 10);

  try {
    const { db } = await import('../services/database.js');

    if (flag === '-read') {
      if (args[1]?.toLowerCase() === 'all') {
        await tasksCommand(ctx);
        return;
      }

      if (isNaN(idParam)) {
        await ctx.reply('❌ Please provide a valid task ID: `/task -read <id>` or `/task -read all`');
        return;
      }

      const task = await db.getTask(idParam, userId);
      if (!task) {
        await ctx.reply('❌ Task not found.');
        return;
      }

      const status = task.completed ? '✅ Completed' : '⬜ Pending';
      const createdAt = new Date(task.created_at).toLocaleString();
      await ctx.reply(`📖 *Task Details (ID: ${task.id})*\n\n*Name:* ${task.name}\n*Description:* ${task.description}\n*Status:* ${status}\n*Created:* ${createdAt}`, { parse_mode: 'Markdown' });
      return;
    }

    if (flag === '-delete') {
      if (isNaN(idParam)) {
        await ctx.reply('❌ Please provide a valid task ID: `/task -delete <id>`');
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
      if (isNaN(idParam)) {
        await ctx.reply('❌ Please provide a valid task ID: `/task -update <id>`');
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

async function tasksCommand(ctx: Context) {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Could not identify user');
    return;
  }

  try {
    const { db } = await import('../services/database.js');
    const tasks = await db.getTasksByUser(userId, 20);

    if (tasks.length === 0) {
      await ctx.reply('📝 You have no tasks yet. Use /task to create one.');
      return;
    }

    const lines = tasks.map((task, index) => {
      const status = task.completed ? '✅' : '⬜';
      const createdAt = task.created_at
        ? new Date(task.created_at).toLocaleDateString()
        : 'unknown date';

      return `${index + 1}. ${status} [ID: ${task.id}] ${task.name}\n   ${task.description}\n   Created: ${createdAt}`;
    });

    const buttons = tasks.map((task, index) =>
      Markup.button.callback(`[${index + 1}]`, `task:toggle:${task.id}`)
    );

    const keyboardRows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      keyboardRows.push(buttons.slice(i, i + 5));
    }
    const keyboard = Markup.inlineKeyboard(keyboardRows);

    await ctx.reply(`📝 Your Tasks (${tasks.length})\n\n${lines.join('\n\n')}`, {
      reply_markup: keyboard.reply_markup
    });
  } catch (error) {
    console.error('Tasks command error:', error);
    if (isMissingTasksTableError(error)) {
      await ctx.reply(
        '❌ Cannot list tasks: database table "tasks" is missing. Run docs/database-schema.sql in Supabase SQL Editor.'
      );
      return;
    }
    await ctx.reply('❌ Failed to fetch tasks. Please try again later.');
  }
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

  const existingDraft = taskDrafts.get(userId);
  const draft: TaskDraft = existingDraft || { chatId: callbackChatId };
  draft.chatId = callbackChatId;
  draft.messageId = callbackMessageId;
  taskDrafts.set(userId, draft);

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

  if (!draft.name?.trim() || !draft.description?.trim()) {
    await ctx.answerCbQuery('Please fill in Name and Description before submitting.', {
      show_alert: true,
    });
    return;
  }

  try {
    const { db } = await import('../services/database.js');

    let confirmation = '';

    if (draft.taskId) {
      await db.updateTask(draft.taskId, userId, draft.name.trim(), draft.description.trim());
      confirmation = `✏️ Task (ID: ${draft.taskId}) updated!\n\nName: ${draft.name.trim()}\nDescription: ${draft.description.trim()}`;
    } else {
      await db.createTask(userId, draft.name.trim(), draft.description.trim());
      confirmation = `✅ Task created!\n\nName: ${draft.name.trim()}\nDescription: ${draft.description.trim()}`;
    }

    try {
      if (draft.messageId) {
        await ctx.telegram.editMessageText(draft.chatId, draft.messageId, undefined, confirmation);
      } else {
        await ctx.reply(confirmation);
      }
    } catch (error) {
      console.error('Error updating task confirmation message:', error);
      await ctx.reply(confirmation);
    }

    taskDrafts.delete(userId);
    try {
      await ctx.answerCbQuery('Task saved');
    } catch (callbackError) {
      console.warn('Task saved but failed to answer callback query:', callbackError);
    }
  } catch (error) {
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
  }
}

async function toggleTaskActionCommand(ctx: Context) {
  const userId = ctx.from?.id;
  const match = (ctx as any).match as RegExpExecArray | undefined;
  const taskIdRaw = match?.[1];

  if (!userId || !taskIdRaw) {
    await ctx.answerCbQuery();
    return;
  }

  const taskId = parseInt(taskIdRaw, 10);
  if (isNaN(taskId)) {
    await ctx.answerCbQuery('Invalid task ID', { show_alert: true });
    return;
  }

  try {
    const { db } = await import('../services/database.js');

    const task = await db.getTask(taskId, userId);
    if (!task) {
      await ctx.answerCbQuery('Task not found', { show_alert: true });
      return;
    }

    const newStatus = !task.completed;
    await db.updateTaskStatus(taskId, userId, newStatus);

    // Fetch refreshed tasks list
    const tasks = await db.getTasksByUser(userId, 20);

    const lines = tasks.map((task, index) => {
      const status = task.completed ? '✅' : '⬜';
      const createdAt = task.created_at
        ? new Date(task.created_at).toLocaleDateString()
        : 'unknown date';

      return `${index + 1}. ${status} [ID: ${task.id}] ${task.name}\n   ${task.description}\n   Created: ${createdAt}`;
    });

    const buttons = tasks.map((task, index) =>
      Markup.button.callback(`[${index + 1}]`, `task:toggle:${task.id}`)
    );

    const keyboardRows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      keyboardRows.push(buttons.slice(i, i + 5));
    }
    const keyboard = Markup.inlineKeyboard(keyboardRows);

    if (ctx.callbackQuery?.message && 'chat' in ctx.callbackQuery.message) {
      await ctx.telegram.editMessageText(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        `📝 Your Tasks (${tasks.length})\n\n${lines.join('\n\n')}`,
        { reply_markup: keyboard.reply_markup }
      );
    }

    await ctx.answerCbQuery(`Task marked as ${newStatus ? 'completed' : 'uncompleted'}`);
  } catch (error) {
    console.error('Toggle task error:', error);
    await ctx.answerCbQuery('Failed to update task', { show_alert: true });
  }
}

async function taskTextInputHandler(ctx: Context) {
  const userId = ctx.from?.id;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';

  if (!userId || !text || text.startsWith('/')) {
    return;
  }

  const draft = taskDrafts.get(userId);
  if (!draft || !draft.awaiting) {
    return;
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
${statusEmoji} *Bot Status*

*Uptime:* ${healthService.formatUptime()}
*Status:* ${health.status.toUpperCase()}

*Components:*
${botEmoji} Bot: ${health.bot.connected ? 'Connected' : 'Disconnected'} (${health.bot.mode})
${dbEmoji} Database: ${health.database.connected ? 'Connected' : 'Disconnected'}${health.database.latency ? ` (${health.database.latency}ms)` : ''}${health.database.error ? `\n⚠️ DB Error: ${health.database.error}` : ''}

*System:*
💾 Memory: ${health.system.memory.used}MB / ${health.system.memory.total}MB (${health.system.memory.percentage}%)
🖥️ Platform: ${health.system.platform}
⚙️ Node: ${health.system.nodeVersion}

*Last Check:* ${new Date(health.timestamp).toLocaleString()}
    `;

    await ctx.reply(statusText, { parse_mode: 'Markdown' });
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
    const { db } = await import('../services/database.js');

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
📊 *Usage Statistics*

*Overall:*
👥 Total Users: ${totalUsers || 0}
📝 Total Commands: ${totalCommands || 0}

*Top Commands (last 100):*
`;

    topCommands.forEach(([cmd, count], index) => {
      statsText += `${index + 1}. ${cmd}: ${count}×\n`;
    });

    await ctx.reply(statsText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Stats command error:', error);
    await ctx.reply('❌ Failed to retrieve statistics');
  }
}
