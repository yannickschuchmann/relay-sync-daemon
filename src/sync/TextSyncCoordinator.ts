import { extname } from "path";
import type { Config } from "../config";
import type { TokenStore } from "../auth/TokenStore";
import type { DocumentMeta, Meta } from "../protocol/types";
import { SyncType, isTextType } from "../protocol/types";
import { DocumentSync } from "./DocumentSync";
import type { FolderSync } from "./FolderSync";
import type { DiskManager } from "../fs/DiskManager";
import type { DocStore } from "../persistence/DocStore";
import { applyTextToYDoc } from "../diff/TextDiff";
import { logger } from "../util/logger";
import { captureError } from "../reporting";
import type { WriteSuppressor } from "./WriteSuppressor";
import { RenameDetector } from "./RenameDetector";

/** How many documents to connect in parallel during initial sync. */
const BATCH_SIZE = 5;

/**
 * Manages the lifecycle of text document connections (DocumentSync instances).
 *
 * Responsibilities:
 * - Initial sync of text documents (batch connect, write to disk)
 * - Handling remote text document additions/deletions
 * - Handling local text file changes (debounced push to Y.Doc)
 * - Creating and deleting remote documents
 * - Rename detection via RenameDetector
 */
export class TextSyncCoordinator {
  private connections: Map<string, DocumentSync> = new Map();
  private localChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly renameDetector = new RenameDetector();

  constructor(
    private config: Config,
    private tokenStore: TokenStore,
    private folderSync: FolderSync,
    private diskManager: DiskManager,
    private docStore: DocStore,
    private suppressor: WriteSuppressor,
  ) {}

  // ---------------------------------------------------------------------------
  // Initial sync
  // ---------------------------------------------------------------------------

  /**
   * Connect and sync a batch of text documents.
   * Processes in batches of BATCH_SIZE to avoid overwhelming the server.
   */
  async syncAll(documents: [string, DocumentMeta][]): Promise<void> {
    logger.info(`Syncing ${documents.length} text documents...`);
    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batch = documents.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ([vpath, meta]) => {
          try {
            await this.syncDocument(vpath, meta);
          } catch (err) {
            captureError(err, { component: "TextSyncCoordinator", operation: "syncDocument", vpath });
          }
        }),
      );
    }
  }

  /**
   * Connect to a single document, get its content, and write to disk.
   */
  private async syncDocument(vpath: string, meta: DocumentMeta): Promise<void> {
    const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
    await this.docStore.load(meta.id, docSync.getDoc());
    await docSync.connect();
    const content = docSync.getContent();
    this.suppressor.suppress(vpath);
    await this.diskManager.writeDocument(vpath, content);
    this.connections.set(vpath, docSync);
    docSync.observeRemoteChanges((p, c) =>
      this.onRemoteDocChange(p, c).catch((err) =>
        captureError(err, { component: "TextSyncCoordinator", operation: "writeRemoteChange", vpath: p }),
      ),
    );
    logger.info(`Synced: ${vpath} (${content.length} chars)`);
  }

  // ---------------------------------------------------------------------------
  // Remote changes
  // ---------------------------------------------------------------------------

  /**
   * Handle a remote file being added (from folder meta observation).
   */
  async onRemoteFileAdded(vpath: string, meta: DocumentMeta): Promise<void> {
    if (this.connections.has(vpath)) return;
    logger.info(`Remote file added: ${vpath}`);
    const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
    await this.docStore.load(meta.id, docSync.getDoc());
    await docSync.connect();
    const content = docSync.getContent();
    this.suppressor.suppress(vpath);
    await this.diskManager.writeDocument(vpath, content);
    this.connections.set(vpath, docSync);
    docSync.observeRemoteChanges((p, c) =>
      this.onRemoteDocChange(p, c).catch((err) =>
        captureError(err, { component: "TextSyncCoordinator", operation: "writeRemoteChange", vpath: p }),
      ),
    );
  }

  /**
   * Handle a remote file being deleted (from folder meta observation).
   */
  async onRemoteFileDeleted(vpath: string): Promise<void> {
    logger.info(`Remote file deleted: ${vpath}`);
    const conn = this.connections.get(vpath);
    if (conn) {
      conn.disconnect();
      this.connections.delete(vpath);
    }
    this.suppressor.suppress(vpath);
    await this.diskManager.deleteDocument(vpath);
  }

  /**
   * Handle remote document text change: write to disk with suppression.
   */
  private async onRemoteDocChange(vpath: string, content: string): Promise<void> {
    this.suppressor.suppress(vpath);
    await this.diskManager.writeDocument(vpath, content);
  }

  // ---------------------------------------------------------------------------
  // Local changes
  // ---------------------------------------------------------------------------

  /**
   * Debounce a local text file change. After debounce, reads from disk
   * and applies the diff to the Y.Doc.
   */
  debouncedLocalChange(vpath: string): void {
    const existing = this.localChangeTimers.get(vpath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.localChangeTimers.delete(vpath);
      (async () => {
        const conn = this.connections.get(vpath);
        if (!conn) {
          logger.debug(`Local change ignored (no connection): ${vpath}`);
          return;
        }
        const diskContent = await this.diskManager.readDocument(vpath);
        applyTextToYDoc(conn.getDoc(), diskContent);
        logger.info(`Pushed local changes to remote: ${vpath}`);
      })().catch((err: unknown) => {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          logger.debug(`File disappeared during debounce (ENOENT), skipping: ${vpath}`);
          return;
        }
        captureError(err, { component: "TextSyncCoordinator", operation: "pushLocalChanges", vpath });
      });
    }, this.config.debounceMs);

    this.localChangeTimers.set(vpath, timer);
  }

  /**
   * Handle a locally added text file: check for rename, or create remote document.
   */
  async onLocalFileAdded(vpath: string): Promise<void> {
    // Try rename detection first
    let newContent: string;
    try {
      newContent = await this.diskManager.readDocument(vpath);
    } catch {
      return;
    }

    const match = this.renameDetector.tryMatchRename(
      vpath,
      newContent,
      (oldVpath) => {
        const conn = this.connections.get(oldVpath);
        return conn ? conn.getContent() : null;
      },
    );

    if (match) {
      // Rename detected -- update filemeta and connections map
      this.folderSync.transactFilemeta(() => {
        const filemeta = this.folderSync.getFilemeta();
        filemeta.delete(match.oldVpath);
        filemeta.set(vpath, match.meta);
      });
      const conn = this.connections.get(match.oldVpath)!;
      conn.setVpath(vpath);
      this.connections.delete(match.oldVpath);
      this.connections.set(vpath, conn);
      return;
    }

    // New file -- create in Relay
    if (!this.connections.has(vpath)) {
      logger.info(`Local file added: ${vpath}`);
      await this.createRemoteDocument(vpath);
    }
  }

  /**
   * Handle a locally deleted text file: buffer for rename detection.
   */
  onLocalFileDeleted(vpath: string): void {
    const conn = this.connections.get(vpath);
    if (conn) {
      const meta = conn.getMeta();
      this.renameDetector.bufferDelete(vpath, meta, (deletedVpath) => {
        this.deleteRemoteDocument(deletedVpath).catch((err) =>
          captureError(err, { component: "TextSyncCoordinator", operation: "deleteRemoteDocument", vpath: deletedVpath }),
        );
      });
    } else {
      logger.debug(`Local file deleted (untracked): ${vpath}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Create / delete remote documents
  // ---------------------------------------------------------------------------

  /**
   * Create a new document in Relay for a locally-added file.
   */
  async createRemoteDocument(vpath: string): Promise<void> {
    const docId = crypto.randomUUID();
    const ext = extname(vpath).slice(1).toLowerCase();
    const type = ext === "canvas" ? SyncType.Canvas : SyncType.Document;

    const meta: DocumentMeta = { version: 0, id: docId, type };

    this.folderSync.transactFilemeta(() => {
      this.folderSync.getFilemeta().set(vpath, meta);
    });

    const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
    await docSync.connect();

    const diskContent = await this.diskManager.readDocument(vpath);
    applyTextToYDoc(docSync.getDoc(), diskContent);

    this.connections.set(vpath, docSync);
    docSync.observeRemoteChanges((p, c) =>
      this.onRemoteDocChange(p, c).catch((err) =>
        captureError(err, { component: "TextSyncCoordinator", operation: "writeRemoteChange", vpath: p }),
      ),
    );

    logger.info(`Created remote document: ${vpath} (${docId})`);
  }

  /**
   * Remove a document from Relay when a local file is deleted.
   */
  async deleteRemoteDocument(vpath: string): Promise<void> {
    const conn = this.connections.get(vpath);
    if (conn) {
      conn.disconnect();
      this.connections.delete(vpath);
    }
    this.folderSync.transactFilemeta(() => {
      this.folderSync.getFilemeta().delete(vpath);
    });
    logger.info(`Deleted remote document: ${vpath}`);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getConnections(): ReadonlyMap<string, DocumentSync> {
    return this.connections;
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Flush all pending debounced local changes and pending renames.
   */
  async flushAndDisconnect(): Promise<void> {
    // Flush pending local text changes
    for (const [vpath, timer] of this.localChangeTimers) {
      clearTimeout(timer);
      try {
        const conn = this.connections.get(vpath);
        if (conn) {
          const diskContent = await this.diskManager.readDocument(vpath);
          applyTextToYDoc(conn.getDoc(), diskContent);
          logger.debug(`Flushed pending local changes on shutdown: ${vpath}`);
        }
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          logger.debug(`File disappeared during shutdown flush (ENOENT), skipping: ${vpath}`);
        } else {
          captureError(err, { component: "TextSyncCoordinator", operation: "flushOnShutdown", vpath });
        }
      }
    }
    this.localChangeTimers.clear();

    // Flush pending renames as confirmed deletes
    await this.renameDetector.flushAll((vpath) => this.deleteRemoteDocument(vpath));

    // Persist all Y.Doc state while connections are still open
    await this.persistAll();

    // Disconnect all document connections
    for (const [vpath, docSync] of this.connections) {
      logger.debug(`Disconnecting document: ${vpath}`);
      docSync.disconnect();
    }
    this.connections.clear();
  }

  /**
   * Persist all document Y.Doc states.
   */
  async persistAll(): Promise<void> {
    const entries = [...this.connections.entries()];
    const results = await Promise.allSettled(
      entries.map(([, docSync]) =>
        this.docStore.save(docSync.getMeta().id, docSync.getDoc()),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        captureError(result.reason, { component: "TextSyncCoordinator", operation: "persistDocState" });
      }
    }
  }
}
