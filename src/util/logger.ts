export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: number;

  constructor(level: LogLevel = "info") {
    this.level = LOG_LEVELS[level];
  }

  setLevel(level: LogLevel): void {
    this.level = LOG_LEVELS[level];
  }

  private format(level: LogLevel, message: string, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    if (args.length === 0) {
      return `${prefix} ${message}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.debug) {
      console.debug(this.format("debug", message, args), ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.info) {
      console.info(this.format("info", message, args), ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.warn) {
      console.warn(this.format("warn", message, args), ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.error) {
      console.error(this.format("error", message, args), ...args);
    }
  }
}

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
const validLevel = envLevel in LOG_LEVELS ? envLevel : "info";

export const logger = new Logger(validLevel);
