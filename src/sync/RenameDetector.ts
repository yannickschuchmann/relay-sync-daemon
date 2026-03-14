import type { Meta } from "../protocol/types";
import { logger } from "../util/logger";
import { captureError } from "../reporting";

/** Default window (ms) to correlate unlink+add as a rename rather than delete+create. */
const DEFAULT_RENAME_WINDOW_MS = 1000;

export interface PendingDelete {
  meta: Meta;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Correlates file delete + add events within a short time window to detect renames.
 *
 * When a file is deleted, the deletion is buffered for the rename window duration.
 * If a new file is added within that window whose content matches the deleted
 * file, it is treated as a rename rather than a delete + create.
 */
export class RenameDetector {
  private pendingDeletes = new Map<string, PendingDelete>();
  private readonly renameWindowMs: number;

  constructor(renameWindowMs: number = DEFAULT_RENAME_WINDOW_MS) {
    this.renameWindowMs = renameWindowMs;
  }

  /**
   * Buffer a file deletion for rename detection.
   * If no matching add arrives within the rename window, `onConfirmedDelete` is called.
   */
  bufferDelete(
    deletedVpath: string,
    meta: Meta,
    onConfirmedDelete: (vpath: string) => void,
  ): void {
    logger.debug(`Buffering delete for rename detection: ${deletedVpath}`);

    const timer = setTimeout(() => {
      this.pendingDeletes.delete(deletedVpath);
      logger.info(`Local file deleted (confirmed): ${deletedVpath}`);
      onConfirmedDelete(deletedVpath);
    }, this.renameWindowMs);

    this.pendingDeletes.set(deletedVpath, { meta, timer });
  }

  /**
   * Check if a newly-added file matches a pending delete (rename detection).
   *
   * @param addedVpath - The virtual path of the newly added file.
   * @param newContent - The content of the newly added file.
   * @param getOldContent - Function that returns the content associated with a
   *   pending delete's vpath (e.g. from a DocumentSync connection).
   *   Return null if the old content is unavailable.
   * @returns The old vpath and meta if a rename was detected, or null.
   */
  tryMatchRename(
    addedVpath: string,
    newContent: string,
    getOldContent: (oldVpath: string) => string | null,
  ): { oldVpath: string; meta: Meta } | null {
    for (const [oldVpath, pending] of this.pendingDeletes) {
      const oldContent = getOldContent(oldVpath);
      if (oldContent === null) continue;
      if (oldContent !== newContent) continue;

      // Content matches -- this is a rename
      clearTimeout(pending.timer);
      this.pendingDeletes.delete(oldVpath);

      logger.info(`Rename detected: ${oldVpath} -> ${addedVpath}`);
      return { oldVpath, meta: pending.meta };
    }

    return null;
  }

  /**
   * Flush all pending deletes immediately (used during shutdown).
   * Calls `onConfirmedDelete` for each pending delete.
   */
  async flushAll(onConfirmedDelete: (vpath: string) => Promise<void>): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [vpath, pending] of this.pendingDeletes) {
      clearTimeout(pending.timer);
      promises.push(
        onConfirmedDelete(vpath).catch((err) =>
          captureError(err, { component: "RenameDetector", operation: "flushAll", vpath }),
        ),
      );
    }
    this.pendingDeletes.clear();
    await Promise.all(promises);
  }

  /**
   * Whether there are any pending deletes.
   */
  get hasPending(): boolean {
    return this.pendingDeletes.size > 0;
  }
}
