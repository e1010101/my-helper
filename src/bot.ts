import { Telegraf } from 'telegraf';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { config } from './config/env.js';
import { registerCommands, isUserInPromptFlow } from './commands/index.js';
import { db } from './services/database.js';
import { HealthService } from './services/health.js';
import { logger } from './services/logger.js';
import { aiService } from './services/ai.js';

let healthServiceInstance: HealthService | null = null;

export function getHealthService(): HealthService | null {
  return healthServiceInstance;
}

export class Bot {
  private bot: Telegraf;
  private healthService: HealthService;
  private httpServer?: ReturnType<typeof createServer>;

  constructor() {
    this.bot = new Telegraf(config.telegram.token);
    this.healthService = new HealthService(this.bot);
    healthServiceInstance = this.healthService;
    this.setupMiddleware();
    this.setupCommands();
    this.setupErrorHandling();
    this.setupHealthEndpoint();
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

    // Handle unknown commands and general text messages
    this.bot.on('text', async (ctx, next) => {
      const text = ctx.message.text;
      const userId = ctx.from?.id;

      logger.info(`Received text message in fallback handler from userId ${userId}: ${text}`);

      if (text.startsWith('/')) {
        const command = text.split(' ')[0];
        // If we get here, the command wasn't handled
        await ctx.reply(
          `❓ Unknown command: ${command}\n\nUse /help to see available commands.`
        );
      } else if (userId) {
        // Check if user is currently filling out a prompt form
        if (isUserInPromptFlow(userId)) {
          logger.info(`Skipping AI response because user ${userId} is in prompt flow`);
          await next();
          return;
        }

        // It's a regular text message, let's pass it to Gemini
        try {
          logger.info(`Passing text to AI service for userId ${userId}`);
          await ctx.sendChatAction('typing');
          const aiResponse = await aiService.generateResponse(userId, text);
          logger.info(`AI Response generated: ${aiResponse.substring(0, 50)}...`);
          await ctx.reply(aiResponse, { parse_mode: 'Markdown' });
        } catch (error) {
          logger.error('Error generating AI response in bot handler', error);
          await ctx.reply('🤖 Sorry, I am having trouble connecting to my brain right now. Please try again later.');
        }
      }
      await next();
    });
  }

  private setupErrorHandling() {
    this.bot.catch((err, ctx) => {
      logger.error('Bot error', err);
      ctx.reply('❌ An error occurred while processing your request.').catch((error) => {
        logger.error('Failed to send error message to user', error);
      });
    });

    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  private setupHealthEndpoint() {
    // Create HTTP server for health checks (works in both polling and webhook modes)
    this.httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Health check endpoint
      if (req.url === '/health' && req.method === 'GET') {
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
        return;
      }

      // 404 for other endpoints
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    this.httpServer.on('error', (error) => {
      logger.error('HTTP server error', error);
    });
  }

  async start() {
    if (config.webhook) {
      // Webhook mode (for production)
      // Create custom HTTP server that handles both webhook and health endpoint
      const { domain, port } = config.webhook;

      logger.info(`Starting bot in webhook mode on port ${port}`, { domain });

      const webhookUrl = `https://${domain}/webhook`;

      // Check if webhook is already set to avoid rate limits
      try {
        const webhookInfo = await this.bot.telegram.getWebhookInfo();
        if (webhookInfo.url !== webhookUrl) {
          logger.info(`Setting webhook to: ${webhookUrl}`);
          await this.bot.telegram.setWebhook(webhookUrl);
          logger.info(`Webhook set successfully`);
        } else {
          logger.info(`Webhook already set to: ${webhookUrl}`);
        }
      } catch (error: any) {
        if (error.response?.error_code === 429) {
          // Rate limited - wait and retry
          const retryAfter = error.response?.parameters?.retry_after || 2;
          logger.warn(`Rate limited. Waiting ${retryAfter} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          await this.bot.telegram.setWebhook(webhookUrl);
          logger.info(`Webhook set after retry`);
        } else {
          throw error;
        }
      }

      // Get Telegraf's webhook callback
      const webhookCallback = await this.bot.createWebhook({ domain, path: '/webhook' });

      // Create HTTP server that handles both webhook and health
      const webhookServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        // Health check endpoint
        if (req.url === '/health' && req.method === 'GET') {
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
          return;
        }

        // Webhook endpoint - delegate to Telegraf
        if (req.url === '/webhook') {
          webhookCallback(req, res);
          return;
        }

        // 404 for other endpoints
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      // Start the webhook server
      await new Promise<void>((resolve) => {
        webhookServer.listen(port, () => {
          logger.info(`Webhook server listening on port ${port}`);
          resolve();
        });
      });

      // Store the webhook server so we can close it later
      this.httpServer = webhookServer;

      logger.info('✅ Bot is running!', {
        mode: 'webhook',
        healthEndpoint: `https://${domain}/health`,
        webhookEndpoint: webhookUrl,
      });
    } else {
      // Polling mode (for development)
      // Start standalone HTTP server for health checks
      const port = 3000;
      await new Promise<void>((resolve) => {
        this.httpServer?.listen(port, () => {
          logger.info(`Health endpoint listening on port ${port}`);
          resolve();
        });
      });

      logger.info('Starting bot in polling mode...');
      await this.bot.launch();

      logger.info('✅ Bot is running!', {
        mode: 'polling',
        healthEndpoint: `http://localhost:${port}/health`,
      });
    }
  }

  async stop(signal: string) {
    logger.info(`Received ${signal}, stopping bot...`);

    // Stop HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => {
          logger.info('HTTP server stopped');
          resolve();
        });
      });
    }

    this.bot.stop(signal);
    logger.info('Bot stopped');
  }

  getBot() {
    return this.bot;
  }
}
