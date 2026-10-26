import { Telegraf } from 'telegraf';

// Telegraf declares the older abort-controller shim, but node-fetch accepts
// native Node signals with the same runtime abort protocol.
type TelegramAbortSignal = NonNullable<Parameters<Telegraf['telegram']['callApi']>[2]>['signal'];

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
    /** False for liveness, which deliberately never waits for the database. */
    checked?: boolean;
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
  private timeoutMs: number;

  constructor(bot: Telegraf, options: { timeoutMs?: number } = {}) {
    this.startTime = Date.now();
    this.bot = bot;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async getHealthStatus(options: { checkDatabase?: boolean } = {}): Promise<HealthStatus> {
    const uptime = Date.now() - this.startTime;
    const memUsage = process.memoryUsage();
    const checkDatabase = options.checkDatabase !== false;

    // Independent, bounded probes. Liveness does not initiate database work at
    // all: even a stalled database must not hold the platform check open.
    const [botConnected, dbStatus] = await Promise.all([
      this.withDeadline((signal) => this.bot.telegram.callApi('getMe', {}, {
        signal: signal as unknown as TelegramAbortSignal,
      }))
        .then(() => true, (error: unknown) => {
          console.error('Bot health check failed:', error);
          return false;
        }),
      checkDatabase
        ? this.withDeadline((signal) => this.checkDatabaseHealth(signal))
          .then((status) => ({ ...status, checked: true }), (error: unknown) => ({
            connected: false,
            checked: true,
            error: error instanceof Error ? error.message : String(error),
          }))
        : Promise.resolve({ connected: false, checked: false }),
    ]);

    const memoryUsed = memUsage.heapUsed / 1024 / 1024; // Convert to MB
    const memoryTotal = memUsage.heapTotal / 1024 / 1024;
    const memoryPercentage = (memoryUsed / memoryTotal) * 100;

    const isHealthy = botConnected && (!checkDatabase || dbStatus.connected);

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

  private async withDeadline<T>(probe: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Health probe timed out after ${this.timeoutMs}ms`));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      // Race as well as abort: an adapter that ignores cancellation must not
      // stop the health endpoint from responding by its deadline.
      return await Promise.race([probe(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkDatabaseHealth(signal: AbortSignal): Promise<{ connected: boolean; latency?: number; error?: string }> {
    try {
      const { db } = await import('./database.js');
      const start = Date.now();

      // Readiness validates every required table, then checks writability.
      const checks = await Promise.all([
        db.getClient().from('user_data').select('user_id').limit(1).abortSignal(signal),
        ...['command_history', 'tasks', 'prompts', 'conversations', 'facts',
          'reminders', 'pending_actions', 'credentials', 'health_probes', 'token_usage']
          .map((table) => db.getClient().from(table).select('id').limit(1).abortSignal(signal)),
      ]);

      const failedCheck = checks.find(result => result.error);
      if (failedCheck?.error) {
        throw new Error(failedCheck.error.message);
      }

      // Reading an RLS-protected table with the wrong key does not error, it
      // simply returns no rows, so a SELECT can never detect a missing
      // service_role key. A write can, and nothing works without one.
      const writeProblem = await probeAssistantTablesWritable(signal);
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
 * Proves the assistant tables are actually writable, so a misconfigured
 * Supabase key is reported with an actionable message instead of surfacing
 * later as mysteriously empty memory.
 *
 * A read cannot detect this: with the wrong key, RLS returns zero rows rather
 * than an error. Only a write reveals it.
 *
 * The probe uses a dedicated `health_probes` row keyed by a fixed id and an
 * upsert, so a monitor polling this endpoint cannot accumulate rows or inflate
 * a sequence. Earlier this inserted into `conversations` and ignored the delete
 * error, which meant a failed cleanup leaked a row per health check forever.
 *
 * Returns a description of the problem, or null when the tables are writable.
 */
async function probeAssistantTablesWritable(signal: AbortSignal): Promise<string | null> {
  const PROBE_ID = 'startup-readiness';

  try {
    const { db } = await import('./database.js');
    const client = db.getClient();

    const { error: upsertError } = await client
      .from('health_probes')
      .upsert({ id: PROBE_ID, checked_at: new Date().toISOString() }, { onConflict: 'id' })
      .abortSignal(signal);

    if (upsertError) {
      if (/permission denied|row-level security|violates row-level/i.test(upsertError.message)) {
        return `cannot write to the assistant tables (${upsertError.message}). ` +
          'Set SUPABASE_SERVICE_ROLE_KEY to the service_role key from Project Settings -> API.';
      }
      return `the assistant tables are not writable: ${upsertError.message}`;
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `assistant table write probe failed: ${message}`;
  }
}
