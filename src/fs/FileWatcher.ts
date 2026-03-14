import { watch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { relative } from "path";
import { logger } from "../util/logger";

export interface FileWatcherHandlers {
  onFileChanged: (vpath: string) => void;
  onFileAdded: (vpath: string) => void;
  onFileDeleted: (vpath: string) => void;
}

/**
 * Watches a local directory for file changes using chokidar.
 * Converts absolute paths to virtual paths (relative to syncDir) before emitting events.
 * Ignores dotfiles, .tmp files, .ystate persistence files, and node_modules.
 * Checks a suppression callback to skip events caused by the daemon's own writes.
 */
export class FileWatcher {
  private watcher: ChokidarWatcher | null = null;

  constructor(
    private syncDir: string,
    private handlers: FileWatcherHandlers,
    private isSuppressed: (vpath: string) => boolean,
  ) {}

  /**
   * Start watching the sync directory for file changes.
   * Uses ignoreInitial to avoid firing for pre-existing files,
   * awaitWriteFinish to wait for writes to stabilize,
   * and atomic to handle atomic save patterns (write to tmp + rename).
   */
  start(): void {
    this.watcher = watch(this.syncDir, {
      ignored: [
        /(^|[/\\])\./,            // dotfiles and dotfolders
        /\.tmp$/,                  // temp files from atomic writes
        /\.ystate$/,               // our persistence files
        "**/node_modules/**",
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
      atomic: true,
    });

    this.watcher
      .on("change", (absPath: string) => {
        const vpath = "/" + relative(this.syncDir, absPath);
        if (this.isSuppressed(vpath)) return;
        this.handlers.onFileChanged(vpath);
      })
      .on("add", (absPath: string) => {
        const vpath = "/" + relative(this.syncDir, absPath);
        if (this.isSuppressed(vpath)) return;
        this.handlers.onFileAdded(vpath);
      })
      .on("unlink", (absPath: string) => {
        const vpath = "/" + relative(this.syncDir, absPath);
        if (this.isSuppressed(vpath)) return;
        this.handlers.onFileDeleted(vpath);
      })
      .on("error", (err: unknown) => {
        logger.error("File watcher error:", err);
      })
      .on("ready", () => {
        logger.info("File watcher ready");
      });
  }

  /**
   * Stop watching and close the watcher.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
