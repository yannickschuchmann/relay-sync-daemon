import type { ErrorContext, ErrorReporter } from "./types";
import { ConsoleReporter } from "./ConsoleReporter";

export type { ErrorContext, ErrorReporter } from "./types";
export { ConsoleReporter } from "./ConsoleReporter";
export { CompositeReporter } from "./CompositeReporter";
export { SentryReporter } from "./SentryReporter";

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let reporter: ErrorReporter = new ConsoleReporter();

export function setErrorReporter(r: ErrorReporter): void {
  reporter = r;
}

export function getErrorReporter(): ErrorReporter {
  return reporter;
}

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------

export function captureError(error: unknown, context: ErrorContext): void {
  reporter.captureError(error, context);
}

export function captureMessage(
  message: string,
  level: "info" | "warning" | "error",
  context: ErrorContext,
): void {
  reporter.captureMessage(message, level, context);
}
