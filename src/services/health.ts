import { Telegraf } from 'telegraf';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  uptime: number;
  timestamp: string;
  bot: {
    connected: boolean;
    mode: 'polling' | 'webhook';
  };
  database: {
    connected: boolean;
    latency?: number;
    error?: string;
  };
  system: {
    memory: {
      used: number;
      total: number;
      percentage: number;
    };
    platform: string;
    nodeVersion: string;
  };
}

export class HealthService {
  private startTime: number;
  private bot: Telegraf;

  constructor(bot: Telegraf) {
    this.startTime = Date.now();
    this.bot = bot;
  }

  async getHealthStatus(): Promise<HealthStatus> {
    const uptime = Date.now() - this.startTime;
    const memUsage = process.memoryUsage();

    // Check bot connection
    let botConnected = false;
    try {
      await this.bot.telegram.getMe();
      botConnected = true;
    } catch (error) {
      console.error('Bot health check failed:', error);
    }

    // Check database connection
    const dbStatus = await this.checkDatabaseHealth();

    const memoryUsed = memUsage.heapUsed / 1024 / 1024; // Convert to MB
    const memoryTotal = memUsage.heapTotal / 1024 / 1024;
    const memoryPercentage = (memoryUsed / memoryTotal) * 100;

    const isHealthy = botConnected && dbStatus.connected;

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      uptime,
      timestamp: new Date().toISOString(),
      bot: {
        connected: botConnected,
        mode: process.env.WEBHOOK_DOMAIN ? 'webhook' : 'polling',
      },
      database: dbStatus,
      system: {
        memory: {
          used: Math.round(memoryUsed),
          total: Math.round(memoryTotal),
          percentage: Math.round(memoryPercentage),
        },
        platform: process.platform,
        nodeVersion: process.version,
      },
    };
  }

  private async checkDatabaseHealth(): Promise<{ connected: boolean; latency?: number; error?: string }> {
    try {
      const { db } = await import('./database.js');
      const start = Date.now();

      // Validate all required tables exist and are queryable.
      const checks = await Promise.all([
        db.getClient().from('user_data').select('user_id').limit(1),
        db.getClient().from('command_history').select('id').limit(1),
        db.getClient().from('tasks').select('id').limit(1),
      ]);

      const failedCheck = checks.find(result => result.error);
      if (failedCheck?.error) {
        throw failedCheck.error;
      }

      const latency = Date.now() - start;
      return { connected: true, latency };
    } catch (error) {
      console.error('Database health check failed:', error);
      const message = error instanceof Error
        ? error.message
        : (typeof error === 'object' && error && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'Unknown database error');
      return { connected: false, error: message };
    }
  }

  getUptime(): number {
    return Date.now() - this.startTime;
  }

  formatUptime(): string {
    const uptime = this.getUptime();
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
