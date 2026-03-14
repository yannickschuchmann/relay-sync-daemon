import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

const LOCK_FILENAME = ".relay.lock";

interface LockData {
  pid: number;
  timestamp: string;
}

/**
 * Simple file-based lock to prevent multiple daemon instances
 * from syncing the same folder simultaneously.
 *
 * Uses `writeFileSync` with `{ flag: 'wx' }` for atomic exclusive
 * creation, avoiding TOCTOU races.
 */
export class LockFile {
  private lockPath: string;

  constructor(baseDir: string) {
    this.lockPath = join(baseDir, LOCK_FILENAME);
  }

  /**
   * Acquire the lock. Throws if another live instance holds it.
   * Uses exclusive-create (`wx`) to atomically claim the lock file,
   * falling back to staleness checks only when the file already exists.
   */
  acquire(): void {
    const data: LockData = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };

    try {
      writeFileSync(this.lockPath, JSON.stringify(data, null, 2) + "\n", {
        flag: "wx",
      });
      logger.debug(`Lock acquired: ${this.lockPath} (PID ${process.pid})`);
      return;
    } catch (err: unknown) {
      // If the error is NOT "file already exists", rethrow
      if (
        !(err instanceof Error) ||
        !("code" in err) ||
        (err as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw err;
      }
    }

    // File already exists — check if the holder is still alive
    const existing = this.readLock();
    if (existing && this.isProcessAlive(existing.pid)) {
      throw new Error(
        `Another daemon instance is already running (PID ${existing.pid}, started ${existing.timestamp}). ` +
          `If this is incorrect, remove ${this.lockPath} and try again.`,
      );
    }

    // Stale lock — previous process died without cleanup
    logger.warn(
      `Removing stale lock file (PID ${existing?.pid ?? "unknown"} is no longer running)`,
    );
    this.forceRelease();

    // Retry the exclusive create after removing the stale file
    try {
      writeFileSync(this.lockPath, JSON.stringify(data, null, 2) + "\n", {
        flag: "wx",
      });
    } catch (retryErr: unknown) {
      if (
        retryErr instanceof Error &&
        "code" in retryErr &&
        (retryErr as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw new Error(
          `Concurrent startup race: another process acquired the lock at ${this.lockPath} ` +
            `between stale lock removal and re-acquisition. Please try again.`,
        );
      }
      throw retryErr;
    }
    logger.debug(`Lock acquired: ${this.lockPath} (PID ${process.pid})`);
  }

  /**
   * Release the lock by removing the lock file.
   * Only removes if the current process owns the lock (PID matches).
   * Safe to call multiple times.
   */
  release(): void {
    try {
      const existing = this.readLock();
      if (existing && existing.pid !== process.pid) {
        logger.warn(
          `Lock file owned by PID ${existing.pid}, not releasing (current PID ${process.pid})`,
        );
        return;
      }
      unlinkSync(this.lockPath);
      logger.debug(`Lock released: ${this.lockPath}`);
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Force-remove the lock file regardless of ownership (for stale lock cleanup).
   */
  private forceRelease(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Best-effort
    }
  }

  private readLock(): LockData | null {
    try {
      const raw = readFileSync(this.lockPath, "utf-8");
      return JSON.parse(raw) as LockData;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
