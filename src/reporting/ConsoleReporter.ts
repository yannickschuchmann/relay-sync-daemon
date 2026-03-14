import { logger } from "../util/logger";
import type { ErrorContext, ErrorReporter } from "./types";

/**
 * Default ErrorReporter implementation that delegates to the existing logger.
 * Produces output identical to the current `logger.error(msg, err)` pattern.
 */
export class ConsoleReporter implements ErrorReporter {
  captureError(error: unknown, context: ErrorContext): void {
    const msg = formatMessage(context, `${context.operation} failed`);
    logger.error(msg, error);
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context: ErrorContext,
  ): void {
    const text = formatMessage(context, message);
    switch (level) {
      case "info":
        logger.info(text);
        break;
      case "warning":
        logger.warn(text);
        break;
      case "error":
        logger.error(text);
        break;
    }
  }
}

function formatMessage(context: ErrorContext, message: string): string {
  const vpathSuffix = context.vpath ? ` (${context.vpath})` : "";
  return `[${context.component}] ${message}${vpathSuffix}`;
}
