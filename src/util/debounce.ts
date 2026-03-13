/**
 * Creates a debounced version of the given function.
 * The function will only be called after `delayMs` milliseconds have elapsed
 * since the last invocation. If called again before the delay expires, the
 * timer resets.
 */
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
}

/**
 * Creates a debounced function that also exposes a `cancel()` method
 * and a `flush()` method to immediately invoke the pending call.
 */
export function debounceCancellable<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): {
  call: (...args: Parameters<T>) => void;
  cancel: () => void;
  flush: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  const flush = (): void => {
    if (timer !== null && pendingArgs !== null) {
      clearTimeout(timer);
      timer = null;
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
  };

  const call = (...args: Parameters<T>): void => {
    pendingArgs = args;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      if (a !== null) {
        fn(...a);
      }
    }, delayMs);
  };

  return { call, cancel, flush };
}
