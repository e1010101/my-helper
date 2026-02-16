import { Telegraf, Context } from 'telegraf';

export interface BotCommand {
  command: string;
  description: string;
  handler: (ctx: Context) => Promise<void>;
}

// Admin user IDs - add your Telegram user ID here
// To find your user ID, message the bot and check the logs, or use a bot like @userinfobot
const ADMIN_USER_IDS = [parseInt(process.env.ADMIN_USER_ID || '0')];

function isAdmin(userId: number | undefined): boolean {
  return userId !== undefined && ADMIN_USER_IDS.includes(userId);
}

export function registerCommands(bot: Telegraf): void {
  // Import and register all commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('ping', pingCommand);
  bot.command('save', saveCommand);
  bot.command('get', getCommand);
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
/save <key> <value> - Save data to your personal storage
/get <key> - Retrieve data from your storage
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

async function saveCommand(ctx: Context) {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.split(' ').slice(1); // Remove /save

  if (parts.length < 2) {
    await ctx.reply('Usage: /save <key> <value>\nExample: /save myNote Remember to buy milk');
    return;
  }

  const key = parts[0];
  const value = parts.slice(1).join(' ');

  // Import database service dynamically to avoid circular dependencies
  const { db } = await import('../services/database.js');
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Could not identify user');
    return;
  }

  try {
    const userData = await db.getUserData(userId) || { data: {} };
    const updatedData = { ...userData.data, [key]: value };
    await db.saveUserData(userId, updatedData);
    await ctx.reply(`✅ Saved "${key}" successfully!`);
  } catch (error) {
    console.error('Save command error:', error);
    await ctx.reply('❌ Failed to save data. Please try again later.');
  }
}

async function getCommand(ctx: Context) {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.split(' ').slice(1);

  if (parts.length !== 1) {
    await ctx.reply('Usage: /get <key>\nExample: /get myNote');
    return;
  }

  const key = parts[0];
  const { db } = await import('../services/database.js');
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('❌ Could not identify user');
    return;
  }

  try {
    const userData = await db.getUserData(userId);

    if (!userData || !userData.data || !(key in userData.data)) {
      await ctx.reply(`❌ No data found for key "${key}"`);
      return;
    }

    await ctx.reply(`📝 *${key}:*\n${userData.data[key]}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Get command error:', error);
    await ctx.reply('❌ Failed to retrieve data. Please try again later.');
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
${statusEmoji} *Bot Status*

*Uptime:* ${healthService.formatUptime()}
*Status:* ${health.status.toUpperCase()}

*Components:*
${botEmoji} Bot: ${health.bot.connected ? 'Connected' : 'Disconnected'} (${health.bot.mode})
${dbEmoji} Database: ${health.database.connected ? 'Connected' : 'Disconnected'}${health.database.latency ? ` (${health.database.latency}ms)` : ''}

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
