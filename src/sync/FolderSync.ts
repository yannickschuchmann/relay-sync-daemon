import * as Y from "yjs";
import { YSweetProvider } from "../protocol/YSweetProvider";
import type { TokenStore } from "../auth/TokenStore";
import type { Config } from "../config";
import type { Meta } from "../protocol/types";
import { folderS3RN } from "../util/s3rn";
import { logger } from "../util/logger";

const FILEMETA_MAP = "filemeta_v0";

export class FolderSync {
  private doc: Y.Doc;
  private filemeta: Y.Map<Meta>;
  private provider: YSweetProvider | null = null;
  private metaObserverFn: ((event: Y.YMapEvent<Meta>, transaction: Y.Transaction) => void) | null = null;
  private config: Config;
  private tokenStore: TokenStore;

  constructor(config: Config, tokenStore: TokenStore) {
    this.config = config;
    this.tokenStore = tokenStore;
    this.doc = new Y.Doc();
    this.filemeta = this.doc.getMap<Meta>(FILEMETA_MAP);
  }

  /**
   * Connect to the folder's Y-Sweet WebSocket.
   * Builds S3RN, fetches a ClientToken, creates the provider, sets awareness,
   * and waits for initial sync to complete.
   */
  async connect(): Promise<void> {
    const s3rn = folderS3RN(this.config.relayGuid, this.config.folderGuid);
    logger.info(`Connecting to folder: ${s3rn}`);

    const clientToken = await this.tokenStore.getToken(s3rn, this.config.relayGuid, this.config.folderGuid, this.config.folderGuid);

    this.provider = new YSweetProvider(
      clientToken.url,
      clientToken.docId,
      this.doc,
      {
        connect: true,
        params: { token: clientToken.token },
        maxBackoffTime: 5000,
        maxConnectionErrors: 10,
      },
    );

    // Set awareness to identify as the sync daemon
    this.provider.awareness.setLocalStateField("user", {
      name: "relay-sync-daemon",
      color: "#888888",
      isBot: true,
    });

    // Wait for initial sync
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Folder sync timed out after 30 seconds"));
      }, 30_000);

      this.provider!.once("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    logger.info(
      `Folder synced. ${this.filemeta.size} files in filemeta_v0`,
    );
  }

  /**
   * List all files from the filemeta_v0 Y.Map.
   * Returns a Map keyed by file path with Meta values.
   */
  listFiles(): Map<string, Meta> {
    const files = new Map<string, Meta>();
    this.filemeta.forEach((meta, path) => {
      files.set(path, meta);
    });
    return files;
  }

  /**
   * Observe changes to the filemeta_v0 Y.Map.
   * Calls handlers for file additions, deletions, and metadata updates.
   */
  observeMetaChanges(handlers: {
    onFileAdded: (vpath: string, meta: Meta) => void;
    onFileDeleted: (vpath: string) => void;
    onFileUpdated: (vpath: string, meta: Meta) => void;
  }): void {
    // Unobserve any existing observer before setting a new one
    if (this.metaObserverFn) {
      this.filemeta.unobserve(this.metaObserverFn);
    }

    this.metaObserverFn = (event, transaction) => {
      // Skip filemeta mutations we made ourselves (create/delete/rename)
      if (transaction.origin === "local-meta-edit") return;

      event.changes.keys.forEach((change, key) => {
        const vpath = key;
        switch (change.action) {
          case "add":
            handlers.onFileAdded(vpath, this.filemeta.get(vpath)!);
            break;
          case "delete":
            handlers.onFileDeleted(vpath);
            break;
          case "update":
            handlers.onFileUpdated(vpath, this.filemeta.get(vpath)!);
            break;
        }
      });
    };

    this.filemeta.observe(this.metaObserverFn);
  }

  /**
   * Get the Y.Doc for this folder (for external observation).
   */
  getDoc(): Y.Doc {
    return this.doc;
  }

  /**
   * Get the filemeta Y.Map for observing changes.
   */
  getFilemeta(): Y.Map<Meta> {
    return this.filemeta;
  }

  /**
   * Get the provider (for token refresh).
   */
  getProvider(): YSweetProvider | null {
    return this.provider;
  }

  /**
   * Execute a callback inside a Y.Doc transaction with "local-meta-edit" origin.
   * This prevents our own filemeta mutations from firing the observeMetaChanges handlers.
   */
  transactFilemeta(fn: () => void): void {
    this.doc.transact(fn, "local-meta-edit");
  }

  /**
   * Disconnect from the folder WebSocket and clean up.
   */
  disconnect(): void {
    if (this.metaObserverFn) {
      this.filemeta.unobserve(this.metaObserverFn);
      this.metaObserverFn = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    this.doc.destroy();
    logger.info("Folder disconnected");
  }
}
