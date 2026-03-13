import { readdir, unlink } from "fs/promises";
import { join, extname } from "path";
import type { Config } from "../config";
import type { TokenStore } from "../auth/TokenStore";
import { FolderSync } from "./FolderSync";
import { DocumentSync } from "./DocumentSync";
import { DiskManager } from "../fs/DiskManager";
import { FileWatcher } from "../fs/FileWatcher";
import { DocStore } from "../persistence/DocStore";
import { applyTextToYDoc } from "../diff/TextDiff";
import { type DocumentMeta, type Meta, SyncType, isTextType } from "../protocol/types";
import { logger } from "../util/logger";

/** How many documents to connect in parallel during initial sync. */
const BATCH_SIZE = 5;

/** How often to persist Y.Doc state (milliseconds). */
const PERSISTENCE_INTERVAL_MS = 30_000;

/** How often to check for tokens nearing expiry (milliseconds). */
const TOKEN_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Refresh tokens that expire within this window (milliseconds). */
const TOKEN_REFRESH_WINDOW_MS = 10 * 60_000;

/** Window (ms) to correlate unlink+add as a rename rather than delete+create. */
const RENAME_WINDOW_MS = 500;

/**
 * How long to suppress watcher events after a daemon-initiated write (ms).
 * Must exceed chokidar's awaitWriteFinish.stabilityThreshold (1000ms) +
 * pollInterval (100ms) plus a safety margin so that the watcher event fires
 * while the path is still suppressed.
 */
const SUPPRESSION_MS = 2000;

/**
 * Orchestrates the full sync lifecycle:
 * - Connects to the folder
 * - Discovers documents from filemeta_v0
 * - Batches document connections
 * - Writes content to disk
 * - Periodically persists Y.Doc state
 *
 * Phase 2 implements initialSync and shutdown basics.
 * Phase 3 adds remote change observation (folder meta + document text).
 * Phase 4 adds local file watching, local-to-remote push via diff-match-patch,
 * create/delete remote documents, and rename detection.
 */
export class SyncCoordinator {
  private folderSync: FolderSync;
  private diskManager: DiskManager;
  private docStore: DocStore;
  private connections: Map<string, DocumentSync> = new Map();
  private suppressedPaths = new Set<string>();
  private suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private persistenceTimer: ReturnType<typeof setInterval> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private fileWatcher: FileWatcher | null = null;
  private localChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingDeletes = new Map<string, { meta: Meta; timer: ReturnType<typeof setTimeout> }>();
  private config: Config;
  private tokenStore: TokenStore;

  constructor(config: Config, tokenStore: TokenStore) {
    this.config = config;
    this.tokenStore = tokenStore;
    this.folderSync = new FolderSync(config, tokenStore);
    this.diskManager = new DiskManager(config.syncDir);
    this.docStore = new DocStore(config.persistenceDir);
  }

  /**
   * Perform initial sync:
   * 1. Clean up orphaned .tmp files
   * 2. Connect to folder, list files
   * 3. Filter to text types (markdown + canvas)
   * 4. Batch-connect documents, extract content, write to disk
   * 5. Start periodic persistence
   */
  async initialSync(): Promise<void> {
    // Clean up any orphaned .tmp files from previous interrupted runs
    await this.cleanupTmpFiles(this.config.syncDir);

    // Load persisted folder Y.Doc state if available (enables incremental sync)
    await this.docStore.load(this.config.folderGuid, this.folderSync.getDoc());

    // Connect to the folder and get the file list
    await this.folderSync.connect();
    const files = this.folderSync.listFiles();

    // Filter to text-based documents (markdown and canvas)
    const documents = [...files.entries()].filter(([, meta]) =>
      isTextType(meta.type),
    ) as [string, DocumentMeta][];

    logger.info(`Syncing ${documents.length} text documents...`);

    // Process in batches to avoid overwhelming the server
    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batch = documents.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ([vpath, meta]) => {
          try {
            await this.syncDocument(vpath, meta);
          } catch (err) {
            logger.error(`Failed to sync document: ${vpath}`, err);
          }
        }),
      );
    }

    // Start periodic persistence
    this.startPersistence();

    logger.info("Initial sync complete.");
  }

  /**
   * Set up observation of remote changes:
   * - Folder metadata changes (file added/deleted/updated)
   * - Document text changes are wired up per-document in syncDocument()
   */
  setupRemoteWatching(): void {
    this.folderSync.observeMetaChanges({
      onFileAdded: async (vpath, meta) => {
        if (this.connections.has(vpath)) return;
        if (isTextType(meta.type)) {
          logger.info(`Remote file added: ${vpath}`);
          try {
            const docSync = new DocumentSync(
              vpath,
              meta as DocumentMeta,
              this.config,
              this.tokenStore,
            );
            await this.docStore.load((meta as DocumentMeta).id, docSync.getDoc());
            await docSync.connect();
            const content = docSync.getContent();
            this.suppressedPaths.add(vpath);
            await this.diskManager.writeDocument(vpath, content);
            const existing = this.suppressionTimers.get(vpath);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => { this.suppressedPaths.delete(vpath); this.suppressionTimers.delete(vpath); }, SUPPRESSION_MS);
            this.suppressionTimers.set(vpath, timer);
            this.connections.set(vpath, docSync);
            docSync.observeRemoteChanges((p, c) => this.onRemoteDocChange(p, c).catch(err => logger.error(`Failed to write remote change for ${p}:`, err)));
          } catch (err) {
            logger.error(`Failed to sync new remote file: ${vpath}`, err);
          }
        }
        // Binary files handled in Phase 5
      },

      onFileDeleted: async (vpath) => {
        try {
          logger.info(`Remote file deleted: ${vpath}`);
          const conn = this.connections.get(vpath);
          if (conn) {
            conn.disconnect();
            this.connections.delete(vpath);
          }
          this.suppressedPaths.add(vpath);
          await this.diskManager.deleteDocument(vpath);
          const existing = this.suppressionTimers.get(vpath);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => { this.suppressedPaths.delete(vpath); this.suppressionTimers.delete(vpath); }, SUPPRESSION_MS);
          this.suppressionTimers.set(vpath, timer);
        } catch (err) {
          logger.error(`Failed to handle remote file deletion: ${vpath}`, err);
        }
      },

      onFileUpdated: async (vpath, meta) => {
        try {
          logger.info(`Remote metadata updated: ${vpath}`);
          // Handle hash changes for binary files (Phase 5)
        } catch (err) {
          logger.error(`Failed to handle remote file update: ${vpath}`, err);
        }
      },
    });
  }

  /**
   * Handle a remote document text change: write to disk with suppression
   * to prevent the file watcher from re-reading the file we just wrote.
   */
  private async onRemoteDocChange(vpath: string, content: string): Promise<void> {
    this.suppressedPaths.add(vpath);
    await this.diskManager.writeDocument(vpath, content);
    // Remove suppression after a delay to let the watcher event pass
    const existing = this.suppressionTimers.get(vpath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { this.suppressedPaths.delete(vpath); this.suppressionTimers.delete(vpath); }, SUPPRESSION_MS);
    this.suppressionTimers.set(vpath, timer);
  }

  /**
   * Check if a path is currently suppressed (recently written by the daemon).
   * Used by the file watcher to avoid echo loops.
   */
  isSuppressed(vpath: string): boolean {
    return this.suppressedPaths.has(vpath);
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Local file watching
  // ---------------------------------------------------------------------------

  /**
   * Set up file watching on the sync directory.
   * Handles local file changes (push to Relay), new files (create remote doc),
   * and deleted files (remove from Relay). Renames are detected by correlating
   * unlink + add events within a short window.
   */
  setupLocalWatching(): void {
    this.fileWatcher = new FileWatcher(
      this.config.syncDir,
      {
        onFileChanged: (vpath) => {
          const ext = extname(vpath).toLowerCase();
          if (ext !== ".md" && ext !== ".canvas") return;
          this.debouncedLocalChange(vpath);
        },

        onFileAdded: (vpath) => {
          // Filter to supported file types (.md and .canvas only)
          const ext = extname(vpath).toLowerCase();
          if (ext !== ".md" && ext !== ".canvas") {
            logger.warn(`Ignoring non-text file (Phase 5): ${vpath}`);
            return;
          }

          // Check if this is a rename (matching a recent delete)
          this.handlePossibleRenameTarget(vpath)
            .then((renamedMeta) => {
              if (renamedMeta) {
                logger.info(`Rename detected: -> ${vpath}`);
                return;
              }

              // New local file -> create in Relay
              if (!this.connections.has(vpath)) {
                logger.info(`Local file added: ${vpath}`);
                return this.createRemoteDocument(vpath);
              }
            })
            .catch((err) =>
              logger.error(`Failed to handle added file ${vpath}:`, err),
            );
        },

        onFileDeleted: (vpath) => {
          // Buffer the delete to allow rename detection
          const conn = this.connections.get(vpath);
          if (conn) {
            const meta = conn.getMeta();
            this.handlePossibleRename(vpath, meta);
          } else {
            // No connection -- just a local file we weren't tracking
            logger.debug(`Local file deleted (untracked): ${vpath}`);
          }
        },
      },
      (vpath) => this.isSuppressed(vpath),
    );

    this.fileWatcher.start();
  }

  /**
   * Debounce local file changes per-path.
   * Reads the file from disk and applies the diff to the Y.Doc
   * after the debounce period (config.debounceMs, default 2s).
   */
  private debouncedLocalChange(vpath: string): void {
    const existing = this.localChangeTimers.get(vpath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.localChangeTimers.delete(vpath);
      try {
        const conn = this.connections.get(vpath);
        if (!conn) {
          logger.debug(`Local change ignored (no connection): ${vpath}`);
          return;
        }
        const diskContent = await this.diskManager.readDocument(vpath);
        applyTextToYDoc(conn.getDoc(), diskContent);
        logger.debug(`Pushed local changes to remote: ${vpath}`);
      } catch (err: unknown) {
        // If the file was deleted during the debounce window, the delete
        // handler will take care of it — treat as a no-op.
        if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          logger.debug(`File disappeared during debounce (ENOENT), skipping: ${vpath}`);
          return;
        }
        logger.error(`Failed to push local changes for ${vpath}:`, err);
      }
    }, this.config.debounceMs);

    this.localChangeTimers.set(vpath, timer);
  }

  /**
   * Create a new document in Relay for a locally-added file.
   * Generates a UUID, adds metadata to filemeta_v0, connects a DocumentSync,
   * and sets the initial content from disk.
   */
  async createRemoteDocument(vpath: string): Promise<void> {
    const docId = crypto.randomUUID();

    // Determine sync type from extension
    const ext = extname(vpath).slice(1).toLowerCase();
    const type = ext === "canvas" ? SyncType.Canvas : SyncType.Document;

    const meta: DocumentMeta = {
      version: 0,
      id: docId,
      type,
    };

    // Add to folder filemeta_v0 (wrapped to avoid triggering our own observer)
    this.folderSync.transactFilemeta(() => {
      this.folderSync.getFilemeta().set(vpath, meta);
    });

    // Connect to the new document
    const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
    await docSync.connect();

    // Read disk content and apply to Y.Doc
    const diskContent = await this.diskManager.readDocument(vpath);
    applyTextToYDoc(docSync.getDoc(), diskContent);

    this.connections.set(vpath, docSync);
    docSync.observeRemoteChanges((p, c) =>
      this.onRemoteDocChange(p, c).catch((err) =>
        logger.error(`Failed to write remote change for ${p}:`, err),
      ),
    );

    logger.info(`Created remote document: ${vpath} (${docId})`);
  }

  /**
   * Remove a document from Relay when a local file is deleted.
   * Disconnects the DocumentSync and removes the entry from filemeta_v0.
   */
  async deleteRemoteDocument(vpath: string): Promise<void> {
    const conn = this.connections.get(vpath);
    if (conn) {
      conn.disconnect();
      this.connections.delete(vpath);
    }

    // Remove from folder metadata (wrapped to avoid triggering our own observer)
    this.folderSync.transactFilemeta(() => {
      this.folderSync.getFilemeta().delete(vpath);
    });

    logger.info(`Deleted remote document: ${vpath}`);
  }

  // ---------------------------------------------------------------------------
  // Rename Detection
  // ---------------------------------------------------------------------------

  /**
   * Buffer a file deletion to allow rename detection.
   * If no matching add arrives within RENAME_WINDOW_MS, the delete is treated
   * as a real deletion.
   */
  private handlePossibleRename(deletedVpath: string, meta: Meta): void {
    logger.debug(`Buffering delete for rename detection: ${deletedVpath}`);

    const timer = setTimeout(() => {
      // No matching add arrived -- treat as a real delete
      this.pendingDeletes.delete(deletedVpath);
      logger.info(`Local file deleted (confirmed): ${deletedVpath}`);
      this.deleteRemoteDocument(deletedVpath).catch((err) =>
        logger.error(`Failed to delete remote document for ${deletedVpath}:`, err),
      );
    }, RENAME_WINDOW_MS);

    this.pendingDeletes.set(deletedVpath, { meta, timer });
  }

  /**
   * Check if a newly-added file matches a pending delete (rename detection).
   * Compares the new file's content against the old document's Y.Text content
   * to avoid false-positive matches. If a match is found, updates filemeta_v0
   * and the connections map to reflect the rename.
   * Returns the matched meta if a rename was detected, or null otherwise.
   */
  private async handlePossibleRenameTarget(addedVpath: string): Promise<Meta | null> {
    let newContent: string;
    try {
      newContent = await this.diskManager.readDocument(addedVpath);
    } catch {
      return null;
    }

    // Look for a pending delete whose content matches the new file
    for (const [oldVpath, pending] of this.pendingDeletes) {
      const conn = this.connections.get(oldVpath);
      if (!conn) continue;

      const oldContent = conn.getContent();
      if (oldContent !== newContent) continue;

      // Content matches — this is a rename
      clearTimeout(pending.timer);
      this.pendingDeletes.delete(oldVpath);

      // Update filemeta atomically: remove old path, set new path with same docId
      this.folderSync.transactFilemeta(() => {
        const filemeta = this.folderSync.getFilemeta();
        filemeta.delete(oldVpath);
        filemeta.set(addedVpath, pending.meta);
      });

      // Update internal connection map
      conn.setVpath(addedVpath);
      this.connections.delete(oldVpath);
      this.connections.set(addedVpath, conn);

      logger.info(`Rename detected: ${oldVpath} -> ${addedVpath}`);
      return pending.meta;
    }

    return null;
  }

  /**
   * Connect to a single document, get its content, and write to disk.
   */
  private async syncDocument(
    vpath: string,
    meta: DocumentMeta,
  ): Promise<void> {
    const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);

    // Load persisted Y.Doc state if available (enables incremental sync)
    await this.docStore.load(meta.id, docSync.getDoc());

    await docSync.connect();
    const content = docSync.getContent();
    await this.diskManager.writeDocument(vpath, content);
    this.connections.set(vpath, docSync);
    docSync.observeRemoteChanges((p, c) => this.onRemoteDocChange(p, c).catch(err => logger.error(`Failed to write remote change for ${p}:`, err)));
    logger.info(`Synced: ${vpath} (${content.length} chars)`);
  }

  /**
   * Start periodic Y.Doc state persistence (every 30s).
   */
  private startPersistence(): void {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
    }

    this.persistenceTimer = setInterval(async () => {
      try {
        await this.persistAll();
      } catch (err) {
        logger.error("Periodic persistence failed", err);
      }
    }, PERSISTENCE_INTERVAL_MS);
  }

  /**
   * Persist all connected Y.Doc states to disk.
   */
  private async persistAll(): Promise<void> {
    const entries = [...this.connections.entries()];

    const results = await Promise.allSettled([
      // Persist all document Y.Docs
      ...entries.map(([, docSync]) =>
        this.docStore.save(docSync.getMeta().id, docSync.getDoc()),
      ),
      // Also persist the folder doc
      this.docStore.save(this.config.folderGuid, this.folderSync.getDoc()),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error("Failed to persist Y.Doc state", result.reason);
      }
    }

    const saved = results.filter((r) => r.status === "fulfilled").length;
    logger.debug(`Persisted ${saved} Y.Doc states`);
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
          // Skip the persistence directory
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

  /**
   * Get the folder sync instance (for external observation in later phases).
   */
  getFolderSync(): FolderSync {
    return this.folderSync;
  }

  /**
   * Get the disk manager (for external use in later phases).
   */
  getDiskManager(): DiskManager {
    return this.diskManager;
  }

  /**
   * Get all active document connections.
   */
  getConnections(): ReadonlyMap<string, DocumentSync> {
    return this.connections;
  }

  /**
   * Start a periodic loop that checks for tokens nearing expiry
   * (within 10 minutes) and refreshes them proactively.
   */
  startTokenRefreshLoop(): void {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
    }

    this.tokenRefreshTimer = setInterval(async () => {
      try {
        const cached = this.tokenStore.getCached();
        const now = Date.now();

        for (const [s3rn, entry] of cached) {
          if (entry.expiryTime - now < TOKEN_REFRESH_WINDOW_MS) {
            logger.info(`Refreshing token for ${s3rn}`);
            try {
              const clientToken = await this.tokenStore.getToken(
                s3rn,
                this.config.relayGuid,
                this.config.folderGuid,
                entry.clientToken.docId,
                { forceRefresh: true },
              );

              // Refresh the folder provider if this is the folder token
              const folderProvider = this.folderSync.getProvider();
              if (folderProvider && entry.clientToken.docId === this.config.folderGuid) {
                folderProvider.refreshToken(clientToken.url, clientToken.docId, clientToken.token);
              }

              // Refresh document providers
              for (const [, docSync] of this.connections) {
                const provider = docSync.getProvider();
                if (provider && docSync.getMeta().id === entry.clientToken.docId) {
                  provider.refreshToken(clientToken.url, clientToken.docId, clientToken.token);
                }
              }
            } catch (err) {
              logger.error(`Failed to refresh token for ${s3rn}`, err);
            }
          }
        }
      } catch (err) {
        logger.error("Token refresh loop failed", err);
      }
    }, TOKEN_REFRESH_INTERVAL_MS);
  }

  /**
   * Graceful shutdown: persist all state, disconnect all documents, disconnect folder.
   */
  async shutdown(): Promise<void> {
    logger.info("SyncCoordinator shutting down...");

    // Stop file watcher
    if (this.fileWatcher) {
      await this.fileWatcher.stop();
      this.fileWatcher = null;
    }

    // Cancel all debounced local change timers
    for (const timer of this.localChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.localChangeTimers.clear();

    // Execute all pending deletes (don't wait for rename window to expire)
    for (const [vpath, pending] of this.pendingDeletes) {
      clearTimeout(pending.timer);
      try {
        await this.deleteRemoteDocument(vpath);
      } catch (err) {
        logger.error(`Failed to delete pending document on shutdown: ${vpath}`, err);
      }
    }
    this.pendingDeletes.clear();

    // Stop periodic persistence
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }

    // Stop token refresh loop
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    // Clear all suppression timers
    for (const timer of this.suppressionTimers.values()) {
      clearTimeout(timer);
    }
    this.suppressionTimers.clear();
    this.suppressedPaths.clear();

    // Final persistence save
    try {
      await this.persistAll();
    } catch (err) {
      logger.error("Failed to persist state during shutdown", err);
    }

    // Disconnect all document connections
    for (const [vpath, docSync] of this.connections) {
      logger.debug(`Disconnecting document: ${vpath}`);
      docSync.disconnect();
    }
    this.connections.clear();

    // Disconnect folder
    this.folderSync.disconnect();

    logger.info("SyncCoordinator shutdown complete.");
  }
}
