export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

class Logger {
  private minLevel: LogLevel;

  constructor() {
    this.minLevel = process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage(LogLevel.INFO, message, meta));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, meta));
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorDetails = error instanceof Error ? {
        message: error.message,
        stack: error.stack,
      } : error;
      console.error(this.formatMessage(LogLevel.ERROR, message, errorDetails));
    }
  }

  // Command execution logger
  logCommand(userId: number, username: string | undefined, command: string): void {
    this.info(`Command executed: ${command}`, {
      userId,
      username: username || 'unknown',
    });
  }

  // API call logger
  logApiCall(method: string, endpoint: string, duration: number, success: boolean): void {
    const level = success ? LogLevel.INFO : LogLevel.WARN;
    const message = `API ${method} ${endpoint} - ${duration}ms - ${success ? 'SUCCESS' : 'FAILED'}`;

    if (level === LogLevel.INFO) {
      this.info(message);
    } else {
      this.warn(message);
    }
  }
}

export const logger = new Logger();
