import { readdir, unlink } from "fs/promises";
import { join, extname } from "path";
import type { Config } from "../config";
import type { AuthManager } from "../auth/AuthManager";
import type { TokenStore } from "../auth/TokenStore";
import { FolderSync } from "./FolderSync";
import { DocumentSync } from "./DocumentSync";
import { DiskManager } from "../fs/DiskManager";
import { FileWatcher } from "../fs/FileWatcher";
import { DocStore } from "../persistence/DocStore";
import {
  type DocumentMeta,
  type FileMetas,
  type Meta,
  isTextType,
  isBinaryType,
  getMimeTypeForExtension,
  getSyncTypeForMimetype,
} from "../protocol/types";
import { logger } from "../util/logger";
import { captureError } from "../reporting";
import { WriteSuppressor } from "./WriteSuppressor";
import { TextSyncCoordinator } from "./TextSyncCoordinator";
import { BinarySyncCoordinator } from "./BinarySyncCoordinator";
import { TokenRefreshManager } from "./TokenRefreshManager";

/** How often to persist Y.Doc state (milliseconds). */
const PERSISTENCE_INTERVAL_MS = 30_000;

/**
 * Orchestrates the full sync lifecycle:
 * - Connects to the folder
 * - Discovers documents from filemeta_v0
 * - Delegates text sync to TextSyncCoordinator
 * - Delegates binary sync to BinarySyncCoordinator
 * - Manages token refresh via TokenRefreshManager
 * - Sets up local and remote file watching
 * - Handles startup and graceful shutdown
 */
export class SyncCoordinator {
  private folderSync: FolderSync;
  private diskManager: DiskManager;
  private docStore: DocStore;
  private suppressor: WriteSuppressor;
  private textSync: TextSyncCoordinator;
  private binarySync: BinarySyncCoordinator;
  private tokenRefresh: TokenRefreshManager;
  private persistenceTimer: ReturnType<typeof setInterval> | null = null;
  private fileWatcher: FileWatcher | null = null;
  private config: Config;

  constructor(config: Config, tokenStore: TokenStore, authManager: AuthManager) {
    this.config = config;
    this.folderSync = new FolderSync(config, tokenStore);
    this.diskManager = new DiskManager(config.syncDir);
    this.docStore = new DocStore(config.persistenceDir);
    this.suppressor = new WriteSuppressor();

    this.textSync = new TextSyncCoordinator(
      config,
      tokenStore,
      this.folderSync,
      this.diskManager,
      this.docStore,
      this.suppressor,
    );

    this.binarySync = new BinarySyncCoordinator(
      config,
      authManager,
      this.folderSync,
      this.diskManager,
      this.suppressor,
    );

    this.tokenRefresh = new TokenRefreshManager(
      config,
      tokenStore,
      this.folderSync,
      () => this.textSync.getConnections(),
    );
  }

  /**
   * Perform initial sync with exponential backoff retry:
   * 1. Clean up orphaned .tmp files
   * 2. Connect to folder, list files
   * 3. Sync text documents and binary files in batches
   * 4. Start periodic persistence
   *
   * Retries up to 3 times with exponential backoff (1s, 2s, 4s) for
   * transient network errors. If all retries fail, the error propagates.
   */
  async initialSync(): Promise<void> {
    await this.cleanupTmpFiles(this.config.syncDir);
    await this.docStore.load(this.config.folderGuid, this.folderSync.getDoc());

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.folderSync.connect();
        break; // Success
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          captureError(err, {
            component: "SyncCoordinator",
            operation: "initialSync",
            extra: { attempt, maxRetries: MAX_RETRIES },
          });
          throw err;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `Folder connect failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const files = this.folderSync.listFiles();

    // Sync text documents
    const documents = [...files.entries()].filter(([, meta]) =>
      isTextType(meta.type),
    ) as [string, DocumentMeta][];
    await this.textSync.syncAll(documents);

    // Sync binary files
    const binaryFiles = [...files.entries()].filter(([, meta]) =>
      isBinaryType(meta.type),
    ) as [string, FileMetas][];
    await this.binarySync.syncAll(binaryFiles);

    this.startPersistence();
    logger.info("Initial sync complete.");
  }

  /**
   * Set up observation of remote changes (folder metadata).
   */
  setupRemoteWatching(): void {
    this.folderSync.observeMetaChanges({
      onFileAdded: async (vpath, meta) => {
        try {
          if (isTextType(meta.type)) {
            await this.textSync.onRemoteFileAdded(vpath, meta as DocumentMeta);
          } else if (isBinaryType(meta.type)) {
            await this.binarySync.onRemoteFileAdded(vpath, meta as FileMetas);
          }
        } catch (err) {
          captureError(err, { component: "SyncCoordinator", operation: "onRemoteFileAdded", vpath });
        }
      },

      onFileDeleted: async (vpath, meta) => {
        try {
          if (isBinaryType(meta.type)) {
            this.suppressor.suppress(vpath);
            await this.diskManager.deleteDocument(vpath);
            logger.info(`Remote binary file deleted: ${vpath}`);
          } else {
            await this.textSync.onRemoteFileDeleted(vpath);
          }
        } catch (err) {
          captureError(err, { component: "SyncCoordinator", operation: "onRemoteFileDeleted", vpath });
        }
      },

      onFileUpdated: async (vpath, meta) => {
        try {
          if (isBinaryType(meta.type)) {
            await this.binarySync.onRemoteBinaryChanged(vpath, meta as FileMetas);
          }
        } catch (err) {
          captureError(err, { component: "SyncCoordinator", operation: "onRemoteFileUpdated", vpath });
        }
      },
    });
  }

  /**
   * Set up file watching on the sync directory.
   */
  setupLocalWatching(): void {
    this.fileWatcher = new FileWatcher(
      this.config.syncDir,
      {
        onFileChanged: (vpath) => {
          const ext = extname(vpath).slice(1).toLowerCase();
          const mimetype = getMimeTypeForExtension(ext);
          const syncType = getSyncTypeForMimetype(mimetype);

          if (isTextType(syncType)) {
            this.textSync.debouncedLocalChange(vpath);
          } else if (isBinaryType(syncType)) {
            this.binarySync.debouncedLocalBinaryChange(vpath);
          }
        },

        onFileAdded: (vpath) => {
          const ext = extname(vpath).slice(1).toLowerCase();
          const mimetype = getMimeTypeForExtension(ext);
          const syncType = getSyncTypeForMimetype(mimetype);

          if (!isTextType(syncType) && !isBinaryType(syncType)) return;

          if (isBinaryType(syncType)) {
            this.binarySync.onLocalFileAdded(vpath, mimetype, syncType);
            return;
          }

          // Text file: check for rename or create
          this.textSync
            .onLocalFileAdded(vpath)
            .catch((err) =>
              captureError(err, { component: "SyncCoordinator", operation: "onLocalFileAdded", vpath }),
            );
        },

        onFileDeleted: (vpath) => {
          this.textSync.onLocalFileDeleted(vpath);
        },
      },
      (vpath) => this.suppressor.isSuppressed(vpath),
    );

    this.fileWatcher.start();
  }

  /**
   * Start the proactive token refresh loop.
   */
  startTokenRefreshLoop(): void {
    this.tokenRefresh.start();
  }

  /**
   * Get the folder sync instance.
   */
  getFolderSync(): FolderSync {
    return this.folderSync;
  }

  /**
   * Get the disk manager.
   */
  getDiskManager(): DiskManager {
    return this.diskManager;
  }

  /**
   * Get all active document connections.
   */
  getConnections(): ReadonlyMap<string, DocumentSync> {
    return this.textSync.getConnections();
  }

  /**
   * Graceful shutdown: persist all state, disconnect everything.
   */
  async shutdown(): Promise<void> {
    logger.info("SyncCoordinator shutting down...");

    // Stop file watcher
    if (this.fileWatcher) {
      await this.fileWatcher.stop();
      this.fileWatcher = null;
    }

    // Stop periodic persistence
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }

    // Flush pending text changes and renames (connections still open)
    await this.textSync.flushAndDisconnect();

    // Persist all Y.Doc state BEFORE disconnecting documents
    try {
      await this.persistAll();
    } catch (err) {
      captureError(err, { component: "SyncCoordinator", operation: "shutdown-persist" });
    }

    // Clear binary debounce timers
    this.binarySync.clearTimers();

    // Stop token refresh loop
    this.tokenRefresh.stop();

    // Clear suppression state
    this.suppressor.clear();

    // Disconnect folder
    this.folderSync.disconnect();

    logger.info("SyncCoordinator shutdown complete.");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Start periodic Y.Doc state persistence.
   */
  private startPersistence(): void {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
    }

    this.persistenceTimer = setInterval(async () => {
      try {
        await this.persistAll();
      } catch (err) {
        captureError(err, { component: "SyncCoordinator", operation: "periodicPersistence" });
      }
    }, PERSISTENCE_INTERVAL_MS);
  }

  /**
   * Persist all Y.Doc states (documents + folder).
   */
  private async persistAll(): Promise<void> {
    await this.textSync.persistAll();

    // Also persist the folder doc
    try {
      await this.docStore.save(this.config.folderGuid, this.folderSync.getDoc());
    } catch (err) {
      captureError(err, { component: "SyncCoordinator", operation: "persistFolderDoc" });
    }
  }

  /**
   * Recursively clean up orphaned .tmp files from previous interrupted writes.
   */
  private async cleanupTmpFiles(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (fullPath === this.config.persistenceDir) continue;
          await this.cleanupTmpFiles(fullPath);
        } else if (entry.name.endsWith(".tmp")) {
          logger.info(`Cleaning up orphaned temp file: ${fullPath}`);
          await unlink(fullPath).catch(() => {});
        }
      }
    } catch {
      // Directory might not exist yet on first run
    }
  }
}
