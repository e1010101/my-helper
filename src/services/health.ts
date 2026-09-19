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

      // conversations/facts/reminders/pending_actions/credentials have RLS
      // enabled. Probing only the tables that already exist keeps a fresh
      // deployment diagnosable while the schema is still being applied.
      const checks = await Promise.all([
        db.getClient().from('user_data').select('user_id').limit(1),
        db.getClient().from('command_history').select('id').limit(1),
        db.getClient().from('tasks').select('id').limit(1),
        db.getClient().from('prompts').select('id').limit(1),
        db.getClient().from('conversations').select('id').limit(1),
        db.getClient().from('facts').select('id').limit(1),
        db.getClient().from('reminders').select('id').limit(1),
      ]);

      const failedCheck = checks.find(result => result.error);
      if (failedCheck?.error) {
        throw new Error(failedCheck.error.message);
      }

      // Reading an RLS-protected table with the wrong key does not error, it
      // simply returns no rows, so a SELECT can never detect a missing
      // service_role key. A write can, and nothing works without one.
      const writeProblem = await probeAssistantTablesWritable();
      if (writeProblem) {
        throw new Error(writeProblem);
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

/**
 * Inserts and then removes a scratch row in an RLS-protected table, so a
 * misconfigured Supabase key is reported with an actionable message instead of
 * being discovered later as mysteriously empty memory.
 *
 * Returns a description of the problem, or null when the tables are writable.
 */
async function probeAssistantTablesWritable(): Promise<string | null> {
  const PROBE_USER_ID = -1; // never a real Telegram user id

  try {
    const { db } = await import('./database.js');
    const client = db.getClient();

    const { error: insertError } = await client
      .from('conversations')
      .insert({ user_id: PROBE_USER_ID, role: 'user', content: 'health probe' });

    if (insertError) {
      if (/permission denied|row-level security|violates row-level/i.test(insertError.message)) {
        return `cannot write to the assistant tables (${insertError.message}). ` +
          'Set SUPABASE_SERVICE_ROLE_KEY to the service_role key from Project Settings -> API.';
      }
      return `the assistant tables are not writable: ${insertError.message}`;
    }

    await client.from('conversations').delete().eq('user_id', PROBE_USER_ID);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `assistant table write probe failed: ${message}`;
  }
}
