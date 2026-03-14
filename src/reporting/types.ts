export interface ErrorContext {
  component: string;
  operation: string;
  vpath?: string;
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  captureError(error: unknown, context: ErrorContext): void;
  captureMessage(message: string, level: "info" | "warning" | "error", context: ErrorContext): void;
  init?(): Promise<void>;
  flush?(): Promise<void>;
}
