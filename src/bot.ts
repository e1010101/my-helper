import { Telegraf, Markup, type Context } from 'telegraf';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { env } from './config/env.js';
import { registerCommands, isUserInPromptFlow } from './commands/index.js';
import { db } from './services/database.js';
import { HealthService } from './services/health.js';
import { logger } from './services/logger.js';
import { markdownToTelegramHtml, escapeHtml } from './utils/telegram-format.js';
import { splitTelegramHtml } from './utils/telegram-chunk.js';
import { SupabaseAssistantStore } from './services/supabase-assistant-store.js';
import { AssistantService } from './services/assistant.js';
import { ReminderScheduler } from './services/reminder-scheduler.js';
import { createDefaultToolRegistry } from './tools/builtin-tools.js';
import { createAIClient } from './services/ai-provider.js';
import { formatLocal } from './services/reminder-time.js';
import { registerAssistantCommands } from './commands/assistant-commands.js';

let healthServiceInstance: HealthService | null = null;

export function getHealthService(): HealthService | null {
  return healthServiceInstance;
}

/** Telegram only accepts these characters in a webhook secret token. */
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

const CONFIRM_CALLBACK = /^assistant:(confirm|reject):(\d+)$/;

type WebhookCallback = (
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  next?: () => void
) => Promise<void>;

export class Bot {
  private bot: Telegraf;
  private healthService: HealthService;
  private httpServer?: ReturnType<typeof createServer>;
  private assistant: AssistantService;
  private scheduler: ReminderScheduler;
  private shutdownHandler?: (signal: NodeJS.Signals) => void;

  constructor() {
    this.bot = new Telegraf(env.telegram().token, {
      telegram: {
        // Automatic webhook replies write to the response socket and conflict
        // with the explicit ctx.reply() calls used throughout the handlers.
        webhookReply: false,
      },
    });

    this.healthService = new HealthService(this.bot);
    healthServiceInstance = this.healthService;

    const store = new SupabaseAssistantStore();
    this.assistant = new AssistantService({
      store,
      registry: createDefaultToolRegistry(),
      client: createAIClient(),
      timezone: env.timezone(),
    });

    this.scheduler = new ReminderScheduler({
      store,
      timezone: env.timezone(),
      deliver: async ({ reminder, late }) => {
        const prefix = late ? '⏰ (missed earlier) ' : '⏰ ';
        await this.sendToOwner(`${prefix}${escapeHtml(reminder.text)}`);
      },
      // The poll is the process heartbeat, so expired confirmations are
      // cleaned up here rather than on a second timer.
      onPoll: () => this.assistant.pruneExpiredConfirmations(),
    });

    this.setupMiddleware();
    this.setupCommands();
    this.setupAssistant();
    this.setupErrorHandling();
  }

  /**
   * The owner's chat id. This is a single-user assistant, so the configured
   * admin id is the chat we proactively message.
   */
  private ownerChatId(): number | null {
    const raw = process.env.ADMIN_USER_ID?.split(',')[0]?.trim();
    if (!raw) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private async sendToOwner(html: string): Promise<void> {
    const chatId = this.ownerChatId();
    if (chatId === null) {
      logger.warn('Cannot deliver message: ADMIN_USER_ID is not configured');
      return;
    }
    await this.bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' });
  }

  private setupMiddleware() {
    // Log all incoming messages
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const username = ctx.from?.username || 'unknown';

      logger.debug(`Message from @${username} (${userId})`);

      // Log command usage to database
      if (ctx.message && 'text' in ctx.message && ctx.message.text.startsWith('/')) {
        const command = ctx.message.text.split(' ')[0];
        logger.logCommand(userId || 0, username, command);
        if (userId) {
          await db.logCommand(userId, command).catch((error) => {
            logger.error('Failed to log command to database', error);
          });
        }
      }

      await next();
    });
  }

  private setupCommands() {
    registerCommands(this.bot);
    registerAssistantCommands(this.bot, this.assistant, env.timezone());
  }

  /** Conversational layer: free-form text plus tool confirmations. */
  private setupAssistant() {
    this.bot.action(CONFIRM_CALLBACK, async (ctx) => {
      const userId = ctx.from?.id;
      const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
      const match = CONFIRM_CALLBACK.exec(data);

      if (!userId || !match) {
        await ctx.answerCbQuery();
        return;
      }

      const [, decision, rawId] = match;
      const actionId = Number.parseInt(rawId, 10);

      await ctx.answerCbQuery();

      try {
        const reply = decision === 'confirm'
          ? await this.assistant.approvePendingAction(userId, actionId)
          : await this.assistant.rejectPendingAction(userId, actionId);

        await this.replyToAssistant(ctx, reply);
      } catch (error) {
        logger.error('Failed to handle confirmation', error);
        await ctx.reply('❌ Something went wrong handling that confirmation.');
      }
    });

    // Handle unknown commands and general text messages
    this.bot.on('text', async (ctx, next) => {
      const text = ctx.message.text;
      const userId = ctx.from?.id;

      logger.info(`Received text message in fallback handler from userId ${userId}: ${text}`);

      if (text.startsWith('/')) {
        const command = text.split(' ')[0];
        await ctx.reply(
          `❓ Unknown command: ${command}\n\nUse /help to see available commands.`
        );
      } else if (userId) {
        // While a form is open, the message belongs to the form, not the model.
        if (isUserInPromptFlow(userId)) {
          logger.info(`Skipping AI response because user ${userId} is in prompt flow`);
          await next();
          return;
        }

        try {
          await ctx.sendChatAction('typing');
          const reply = await this.assistant.processMessage(userId, text);
          await this.replyToAssistant(ctx, reply);
        } catch (error) {
          logger.error('Error generating AI response in bot handler', error);
          await ctx.reply('🤖 Sorry, I am having trouble connecting to my brain right now. Please try again later.');
        }
      }
      await next();
    });
  }

  private async replyToAssistant(
    ctx: Context,
    reply: Awaited<ReturnType<AssistantService['processMessage']>>
  ): Promise<void> {
    if (reply.kind === 'confirmation') {
      const { id, summary, toolName } = reply.confirmation;
      const text =
        `🤔 <b>Confirm action</b>\n\n` +
        `<b>${escapeHtml(toolName)}</b>\n${escapeHtml(summary)}\n\n` +
        `This will change your data. Confirm?`;

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirm', `assistant:confirm:${id}`),
            Markup.button.callback('🚫 Cancel', `assistant:reject:${id}`),
          ],
        ]).reply_markup,
      });
      return;
    }

    // Models answer in standard Markdown, which Telegram's legacy Markdown
    // parser renders incorrectly, so convert to HTML instead. Long answers are
    // split: a single over-limit message is rejected outright, which would
    // otherwise surface as a misleading "having trouble" error.
    await this.sendLongHtml(ctx, markdownToTelegramHtml(reply.text));
  }

  /**
   * Sends HTML that may exceed Telegram's message limit, continuing in
   * follow-up messages. The first part is always sent even if a later one
   * fails, so a partial answer still reaches the user.
   */
  private async sendLongHtml(ctx: Context, html: string): Promise<void> {
    const chunks = splitTelegramHtml(html);

    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Failed to send part of a message', error);
        if (chunks.length > 1) {
          await ctx.reply('⚠️ Part of my answer could not be delivered.').catch(() => undefined);
        }
        return;
      }
    }
  }

  private setupErrorHandling() {
    this.bot.catch((err, ctx) => {
      logger.error('Bot error', err);
      ctx.reply('❌ An error occurred while processing your request.').catch((error) => {
        logger.error('Failed to send error message to user', error);
      });
    });

    // Kept on the instance so a shutdown can remove them (and so tests do not
    // leave handlers behind that fire during process teardown).
    this.shutdownHandler = (signal: NodeJS.Signals) => {
      void this.stop(signal);
    };

    process.once('SIGINT', this.shutdownHandler);
    process.once('SIGTERM', this.shutdownHandler);
  }

  /** Detaches the process signal handlers registered by setupErrorHandling. */
  dispose(): void {
    if (this.shutdownHandler) {
      process.removeListener('SIGINT', this.shutdownHandler);
      process.removeListener('SIGTERM', this.shutdownHandler);
      this.shutdownHandler = undefined;
    }
  }

  /**
   * Serves the health endpoint (and the bare root, which some platform
   * healthchecks probe) so both polling and webhook modes stay observable.
   */
  private async handleHealthRequest(res: ServerResponse): Promise<void> {
    try {
      const health = await this.healthService.getHealthStatus();
      res.writeHead(health.status === 'healthy' ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(health, null, 2));
    } catch (error) {
      logger.error('Health check failed', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Health check failed' }));
    }
  }

  private createHttpServer(webhookCallback?: WebhookCallback) {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url || '/').split('?')[0];

      if ((path === '/health' || path === '/') && req.method === 'GET') {
        await this.handleHealthRequest(res);
        return;
      }

      // Webhook endpoint - delegate to Telegraf
      if (webhookCallback && path === '/webhook' && req.method === 'POST') {
        await webhookCallback(req, res);
        return;
      }

      // 404 for other endpoints
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.on('error', (error) => {
      logger.error('HTTP server error', error);
    });

    return server;
  }

  private listen(server: ReturnType<typeof createServer>, port: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // Bind explicitly to all interfaces: platform healthchecks reach the
      // container over the network, so a localhost-only bind fails them.
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', reject);
        logger.info(`${label} listening on 0.0.0.0:${port}`);
        resolve();
      });
    });
  }

  async start() {
    if (env.webhook()) {
      // Webhook mode (for production)
      const { domain, port, secretToken } = env.webhook()!;

      if (secretToken && !WEBHOOK_SECRET_PATTERN.test(secretToken)) {
        logger.warn(
          'WEBHOOK_SECRET is ignored: Telegram only allows A-Z, a-z, 0-9, "_" and "-" (max 256 chars)'
        );
      }

      const webhookUrl = `https://${domain}/webhook`;
      logger.info(`Starting bot in webhook mode on port ${port}`, { domain, webhookUrl });

      // Tell Telegram about the endpoint. createWebhook() also registers the
      // URL, so no separate setWebhook() call is needed (and no double request).
      const webhookCallback = await this.retryOnRateLimit(
        () => this.bot.createWebhook({
          domain,
          path: '/webhook',
          ...(secretToken ? { secret_token: secretToken } : {}),
        }) as Promise<WebhookCallback>
      );

      // Verify the API credentials are usable before declaring success.
      try {
        await this.bot.telegram.getMe();
      } catch (error) {
        logger.error('Failed to reach the Telegram API with the configured token', error);
        throw error;
      }

      const webhookServer = this.createHttpServer(webhookCallback);
      await this.listen(webhookServer, port, 'Webhook server');
      this.httpServer = webhookServer;

      this.startScheduler();

      logger.info('✅ Bot is running!', {
        mode: 'webhook',
        healthEndpoint: `https://${domain}/health`,
        webhookEndpoint: webhookUrl,
        webhookSecretEnabled: Boolean(secretToken),
      });
    } else {
      // Polling mode (for development)
      const port = env.port();

      this.httpServer = this.createHttpServer();
      await this.listen(this.httpServer, port, 'Health endpoint');

      logger.info('Starting bot in polling mode...');

      // launch() resolves only when polling *stops*: it returns the long-poll
      // loop promise. Awaiting it here would block everything after it, which
      // previously meant the scheduler never started in polling mode and
      // reminders were never delivered. Start it in the background and treat
      // rejection as fatal instead.
      void this.bot.launch().catch((error) => {
        logger.error('Bot polling failed; exiting', error);
        process.exit(1);
      });

      this.startScheduler();

      logger.info('✅ Bot is running!', {
        mode: 'polling',
        healthEndpoint: `http://localhost:${port}/health`,
      });
    }
  }

  private startScheduler() {
    if (this.ownerChatId() === null) {
      logger.warn('Reminder scheduler not started: ADMIN_USER_ID is unset, so reminders have no destination');
      return;
    }

    this.scheduler.start();
    logger.info('Reminders will be delivered to the configured owner', {
      timezone: env.timezone(),
      note: `next poll every 30s; local time now ${formatLocal(new Date(), env.timezone())}`,
    });
  }

  /**
   * Telegram rate limits setWebhook/getWebhookInfo calls. On 429 we honour the
   * server-provided retry_after before trying once more.
   */
  private async retryOnRateLimit<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      const response = (error as { response?: { error_code?: number; parameters?: { retry_after?: number } } })?.response;

      if (response?.error_code !== 429) {
        throw error;
      }

      const retryAfter = response.parameters?.retry_after ?? 2;
      logger.warn(`Rate limited by Telegram. Waiting ${retryAfter}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return await attempt();
    }
  }

  async stop(signal: string) {
    logger.info(`Received ${signal}, stopping bot...`);

    this.scheduler.stop();

    // Stop HTTP server. close() waits for open keep-alive connections to end,
    // which can outlive a platform restart.
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = undefined;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn('HTTP server close timed out; forcing remaining connections shut');
          server.closeAllConnections?.();
          resolve();
        }, 5000);

        server.close(() => {
          clearTimeout(timer);
          logger.info('HTTP server stopped');
          resolve();
        });

        // Drop connections sitting idle in the keep-alive pool without
        // interrupting requests that are still being served.
        server.closeIdleConnections?.();
      });
    }

    // Telegraf throws "Bot is not running!" when stop() is called before a
    // successful launch; a failed startup must still be able to shut down.
    try {
      this.bot.stop(signal);
    } catch (error) {
      logger.warn('Bot was not running at shutdown', { reason: String(error) });
    }
    logger.info('Bot stopped');
  }

  getBot() {
    return this.bot;
  }

  getAssistant() {
    return this.assistant;
  }
}
