import type { ErrorContext, ErrorReporter } from "./types";
import { logger } from "../util/logger";

/**
 * Sentry adapter for ErrorReporter.
 *
 * Uses dynamic import so @sentry/bun is not a hard dependency.
 * If @sentry/bun is not installed, init() throws a clear error message.
 * Reads SENTRY_DSN from the environment.
 */
export class SentryReporter implements ErrorReporter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Sentry: any = null;

  async init(): Promise<void> {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
      throw new Error(
        "SentryReporter requires the SENTRY_DSN environment variable to be set",
      );
    }

    try {
      // Use a variable to prevent TypeScript from resolving the module at compile time
      const sentryModule = "@sentry/bun";
      this.Sentry = await import(/* @vite-ignore */ sentryModule);
    } catch {
      throw new Error(
        "SentryReporter requires @sentry/bun to be installed. Run: bun add @sentry/bun",
      );
    }

    this.Sentry.init({ dsn });
    logger.info("Sentry initialized");
  }

  captureError(error: unknown, context: ErrorContext): void {
    if (!this.Sentry) return;
    const Sentry = this.Sentry;

    Sentry.withScope((scope: any) => {
      scope.setTag("component", context.component);
      scope.setTag("operation", context.operation);
      if (context.vpath) {
        scope.setTag("vpath", context.vpath);
      }
      if (context.extra) {
        scope.setExtras(context.extra);
      }
      if (error instanceof Error) {
        Sentry.captureException(error);
      } else {
        Sentry.captureException(new Error(String(error)));
      }
    });
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context: ErrorContext,
  ): void {
    if (!this.Sentry) return;
    const Sentry = this.Sentry;

    Sentry.withScope((scope: any) => {
      scope.setTag("component", context.component);
      scope.setTag("operation", context.operation);
      if (context.vpath) {
        scope.setTag("vpath", context.vpath);
      }
      if (context.extra) {
        scope.setExtras(context.extra);
      }
      Sentry.captureMessage(message, level);
    });
  }

  async flush(): Promise<void> {
    if (!this.Sentry) return;
    await this.Sentry.flush(2000);
  }
}
