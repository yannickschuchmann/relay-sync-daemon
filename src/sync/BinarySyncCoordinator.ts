import type { Config } from "../config";
import type { AuthManager } from "../auth/AuthManager";
import type { FileMetas } from "../protocol/types";
import { SyncType, isBinaryType } from "../protocol/types";
import { BinarySync } from "./BinarySync";
import type { FolderSync } from "./FolderSync";
import type { DiskManager } from "../fs/DiskManager";
import type { WriteSuppressor } from "./WriteSuppressor";
import { logger } from "../util/logger";
import { captureError } from "../reporting";

/** How many binary files to process in parallel during initial sync. */
const BATCH_SIZE = 5;

/**
 * Manages binary file sync (images, PDFs, audio, video).
 *
 * Responsibilities:
 * - Initial download of binary files
 * - Uploading local binary changes to the remote CAS
 * - Downloading remote binary changes
 * - Creating new remote binary files for locally-added files
 */
export class BinarySyncCoordinator {
  private binarySync: BinarySync;
  private localChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private config: Config,
    authManager: AuthManager,
    private folderSync: FolderSync,
    private diskManager: DiskManager,
    private suppressor: WriteSuppressor,
  ) {
    this.binarySync = new BinarySync(config, authManager);
  }

  // ---------------------------------------------------------------------------
  // Initial sync
  // ---------------------------------------------------------------------------

  /**
   * Download all binary files in batches.
   */
  async syncAll(binaryFiles: [string, FileMetas][]): Promise<void> {
    logger.info(`Syncing ${binaryFiles.length} binary files...`);
    for (let i = 0; i < binaryFiles.length; i += BATCH_SIZE) {
      const batch = binaryFiles.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ([vpath, meta]) => {
          try {
            const content = await this.binarySync.downloadFile(vpath, meta);
            await this.diskManager.writeBinary(vpath, content);
            logger.info(`Downloaded binary: ${vpath} (${content.byteLength} bytes)`);
          } catch (err) {
            captureError(err, { component: "BinarySyncCoordinator", operation: "downloadBinary", vpath });
          }
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Remote changes
  // ---------------------------------------------------------------------------

  /**
   * Handle a remote binary file being added (from folder meta observation).
   */
  async onRemoteFileAdded(vpath: string, meta: FileMetas): Promise<void> {
    logger.info(`Remote binary file added: ${vpath}`);
    await this.onRemoteBinaryChanged(vpath, meta);
  }

  /**
   * Handle a remote binary file change (hash changed = new version available).
   * Compares local hash with remote meta hash, downloads if different.
   */
  async onRemoteBinaryChanged(vpath: string, meta: FileMetas): Promise<void> {
    // Check if local hash matches (file already up to date)
    try {
      const localContent = await this.diskManager.readBinary(vpath);
      const localHash = this.binarySync.computeSHA256(localContent);
      if (localHash === meta.hash) {
        logger.debug(`Binary already up to date: ${vpath}`);
        return;
      }
    } catch {
      // File doesn't exist locally yet -- download it
    }

    const content = await this.binarySync.downloadFile(vpath, meta);
    this.suppressor.suppress(vpath);
    await this.diskManager.writeBinary(vpath, content);
    logger.info(`Updated binary from remote: ${vpath} (${content.byteLength} bytes)`);
  }

  // ---------------------------------------------------------------------------
  // Local changes
  // ---------------------------------------------------------------------------

  /**
   * Debounce a local binary file change.
   * After the debounce period, reads the file and uploads if the hash has changed.
   */
  debouncedLocalBinaryChange(vpath: string): void {
    const existing = this.localChangeTimers.get(vpath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.localChangeTimers.delete(vpath);
      this.onLocalBinaryChanged(vpath).catch((err: unknown) => {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          logger.debug(`Binary file disappeared during debounce (ENOENT), skipping: ${vpath}`);
          return;
        }
        captureError(err, { component: "BinarySyncCoordinator", operation: "pushLocalBinaryChanges", vpath });
      });
    }, this.config.debounceMs);

    this.localChangeTimers.set(vpath, timer);
  }

  /**
   * Handle a local binary file change: compute hash, compare with filemeta,
   * upload if changed, and update filemeta_v0.
   */
  async onLocalBinaryChanged(vpath: string): Promise<void> {
    const meta = this.folderSync.getFilemeta().get(vpath) as FileMetas | undefined;
    if (!meta) {
      logger.debug(`Local binary change ignored (no metadata): ${vpath}`);
      return;
    }

    const content = await this.diskManager.readBinary(vpath);
    const newHash = this.binarySync.computeSHA256(content);

    if (newHash === meta.hash) {
      logger.debug(`Binary unchanged (hash match), skipping: ${vpath}`);
      return;
    }

    await this.binarySync.uploadFile(vpath, meta, content, newHash);

    this.folderSync.transactFilemeta(() => {
      this.folderSync.getFilemeta().set(vpath, {
        ...meta,
        hash: newHash,
        synctime: Date.now(),
      });
    });

    logger.info(`Uploaded binary: ${vpath}`);
  }

  /**
   * Handle a locally-added binary file that doesn't yet exist on the remote.
   * Also handles the case where the file is already tracked (re-upload).
   */
  onLocalFileAdded(vpath: string, mimetype: string, syncType: SyncType): void {
    const meta = this.folderSync.getFilemeta().get(vpath);
    if (meta && isBinaryType(meta.type)) {
      // Already tracked -- treat as a change (re-upload)
      this.debouncedLocalBinaryChange(vpath);
    } else if (!meta) {
      // New binary file
      logger.info(`Local binary file added: ${vpath}`);
      this.createRemoteBinaryFile(vpath, mimetype, syncType).catch((err) =>
        captureError(err, { component: "BinarySyncCoordinator", operation: "createRemoteBinary", vpath }),
      );
    }
  }

  /**
   * Create a new binary file in Relay for a locally-added binary file.
   */
  async createRemoteBinaryFile(
    vpath: string,
    mimetype: string,
    syncType: SyncType,
  ): Promise<void> {
    const fileId = crypto.randomUUID();

    const content = await this.diskManager.readBinary(vpath);
    const hash = this.binarySync.computeSHA256(content);

    const meta: FileMetas = {
      version: 0,
      id: fileId,
      type: syncType as FileMetas["type"],
      hash,
      mimetype,
      synctime: Date.now(),
    };

    await this.binarySync.uploadFile(vpath, meta, content, hash);

    this.folderSync.transactFilemeta(() => {
      this.folderSync.getFilemeta().set(vpath, meta);
    });

    logger.info(`Created remote binary file: ${vpath} (${fileId})`);
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Clear any pending debounce timers.
   */
  clearTimers(): void {
    for (const timer of this.localChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.localChangeTimers.clear();
  }
}
