import { Telegraf } from 'telegraf';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { config } from './config/env.js';
import { registerCommands } from './commands/index.js';
import { db } from './services/database.js';
import { HealthService } from './services/health.js';
import { logger } from './services/logger.js';

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

    // Handle unknown commands
    this.bot.on('text', async (ctx, next) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) {
        const command = text.split(' ')[0];
        // If we get here, the command wasn't handled
        await ctx.reply(
          `❓ Unknown command: ${command}\n\nUse /help to see available commands.`
        );
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
      await this.bot.telegram.setWebhook(webhookUrl);
      logger.info(`Webhook set to: ${webhookUrl}`);

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
