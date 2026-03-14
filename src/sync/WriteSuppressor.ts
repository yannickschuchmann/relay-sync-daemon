/**
 * Manages write suppression to prevent the file watcher from re-reading
 * files that the daemon itself just wrote.
 *
 * After a daemon-initiated write, the path is suppressed for SUPPRESSION_MS
 * so that the corresponding chokidar event is ignored.
 */

/**
 * How long to suppress watcher events after a daemon-initiated write (ms).
 * Must exceed chokidar's awaitWriteFinish.stabilityThreshold (1000ms) +
 * pollInterval (100ms) plus a safety margin so that the watcher event fires
 * while the path is still suppressed.
 */
const DEFAULT_SUPPRESSION_MS = 2000;

export class WriteSuppressor {
  private suppressedPaths = new Set<string>();
  private suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly suppressionMs: number;

  constructor(suppressionMs: number = DEFAULT_SUPPRESSION_MS) {
    this.suppressionMs = suppressionMs;
  }

  /**
   * Suppress a path for the configured suppression duration. If already suppressed, resets the timer.
   */
  suppress(vpath: string): void {
    this.suppressedPaths.add(vpath);
    const existing = this.suppressionTimers.get(vpath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.suppressedPaths.delete(vpath);
      this.suppressionTimers.delete(vpath);
    }, this.suppressionMs);
    this.suppressionTimers.set(vpath, timer);
  }

  /**
   * Check if a path is currently suppressed.
   */
  isSuppressed(vpath: string): boolean {
    return this.suppressedPaths.has(vpath);
  }

  /**
   * Clear all suppression state (used during shutdown).
   */
  clear(): void {
    for (const timer of this.suppressionTimers.values()) {
      clearTimeout(timer);
    }
    this.suppressionTimers.clear();
    this.suppressedPaths.clear();
  }
}
