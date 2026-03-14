import type { ErrorContext, ErrorReporter } from "./types";

/**
 * Fan-out ErrorReporter that delegates to multiple reporters.
 * Each reporter call is wrapped in try/catch so one reporter's failure
 * doesn't prevent others from running.
 */
export class CompositeReporter implements ErrorReporter {
  private reporters: ErrorReporter[];

  constructor(reporters: ErrorReporter[]) {
    this.reporters = reporters;
  }

  captureError(error: unknown, context: ErrorContext): void {
    for (const reporter of this.reporters) {
      try {
        reporter.captureError(error, context);
      } catch (err) {
        console.error("CompositeReporter: captureError failed for reporter", err);
      }
    }
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context: ErrorContext,
  ): void {
    for (const reporter of this.reporters) {
      try {
        reporter.captureMessage(message, level, context);
      } catch (err) {
        console.error("CompositeReporter: captureMessage failed for reporter", err);
      }
    }
  }

  async init(): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.init?.();
      } catch (err) {
        console.error("CompositeReporter: init failed for reporter", err);
      }
    }
  }

  async flush(): Promise<void> {
    for (const reporter of this.reporters) {
      try {
        await reporter.flush?.();
      } catch (err) {
        console.error("CompositeReporter: flush failed for reporter", err);
      }
    }
  }
}
