import * as Y from "yjs";
import { YSweetProvider } from "../protocol/YSweetProvider";
import type { TokenStore } from "../auth/TokenStore";
import type { Config } from "../config";
import { type DocumentMeta, SyncType } from "../protocol/types";
import { documentS3RN, canvasS3RN } from "../util/s3rn";
import { logger } from "../util/logger";

/**
 * Manages a single document's Y.Doc connection.
 * Connects via YSweetProvider, extracts text from Y.Text("contents").
 */
export class DocumentSync {
  private ydoc: Y.Doc;
  private provider: YSweetProvider | null = null;
  private ytext: Y.Text;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private observerFn: ((event: Y.YTextEvent, transaction: Y.Transaction) => void) | null = null;
  private readonly debounceMs = 300;

  constructor(
    private vpath: string,
    private meta: DocumentMeta,
    private config: Config,
    private tokenStore: TokenStore,
  ) {
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("contents");
  }

  /**
   * Build the S3RN for this document (canvas or doc).
   */
  private getS3RN(): string {
    return this.meta.type === SyncType.Canvas
      ? canvasS3RN(this.config.relayGuid, this.config.folderGuid, this.meta.id)
      : documentS3RN(this.config.relayGuid, this.config.folderGuid, this.meta.id);
  }

  /**
   * Connect to the document's Y-Sweet WebSocket.
   * Builds S3RN based on SyncType (canvas vs doc), fetches a ClientToken,
   * creates the provider, sets awareness, and waits for initial sync.
   * Also registers a retries-exhausted handler to automatically recover.
   */
  async connect(): Promise<void> {
    const s3rn = this.getS3RN();

    const clientToken = await this.tokenStore.getToken(
      s3rn,
      this.config.relayGuid,
      this.config.folderGuid,
      this.meta.id,
    );

    this.provider = new YSweetProvider(
      clientToken.url,
      clientToken.docId,
      this.ydoc,
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

    // Handle exhausted retries: get fresh token and reconnect
    this.provider.on("retries-exhausted", () => {
      this.handleRetriesExhausted().catch((err) =>
        logger.error(`Failed to recover document connection for ${this.vpath} after retries exhausted`, err),
      );
    });

    // Wait for initial sync
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Document sync timed out after 30s: ${this.vpath}`));
      }, 30_000);

      this.provider!.once("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Handle exhausted reconnection retries by requesting a fresh token
   * and reconnecting the existing provider.
   */
  private async handleRetriesExhausted(): Promise<void> {
    const s3rn = this.getS3RN();
    logger.info(`Requesting fresh token for ${this.vpath} after retries exhausted`);

    try {
      const clientToken = await this.tokenStore.getToken(
        s3rn,
        this.config.relayGuid,
        this.config.folderGuid,
        this.meta.id,
        { forceRefresh: true },
      );

      if (this.provider) {
        this.provider.refreshToken(clientToken.url, clientToken.docId, clientToken.token);
        this.provider.resetAndReconnect();
        logger.info(`Document connection recovered for ${this.vpath}`);
      }
    } catch (err) {
      logger.error(`Failed to get fresh token for ${this.vpath}`, err);
    }
  }

  /**
   * Get the current text content of the document.
   */
  getContent(): string {
    return this.ytext.toString();
  }

  /**
   * Get the Y.Doc for this document (for persistence and external observation).
   */
  getDoc(): Y.Doc {
    return this.ydoc;
  }

  /**
   * Get the Y.Text for this document (for applying diffs).
   */
  getText(): Y.Text {
    return this.ytext;
  }

  /**
   * Get the provider (for token refresh).
   */
  getProvider(): YSweetProvider | null {
    return this.provider;
  }

  /**
   * Get the virtual path of this document.
   */
  getVpath(): string {
    return this.vpath;
  }

  /**
   * Update the virtual path (used during rename detection).
   */
  setVpath(vpath: string): void {
    this.vpath = vpath;
  }

  /**
   * Get the document metadata.
   */
  getMeta(): DocumentMeta {
    return this.meta;
  }

  /**
   * Observe remote changes to the document text.
   * Skips changes with "local-edit" origin (our own local file edits).
   * Debounces rapid remote edits before calling the callback.
   */
  observeRemoteChanges(onUpdate: (vpath: string, content: string) => void): void {
    // Guard against double registration: unobserve old handler first
    if (this.observerFn) {
      this.ytext.unobserve(this.observerFn);
    }

    this.observerFn = (event, transaction) => {
      // Skip changes we originated (from local file edits)
      if (transaction.origin === "local-edit") return;

      // Debounce to batch rapid remote edits
      this.scheduleWrite(onUpdate);
    };

    this.ytext.observe(this.observerFn);
  }

  private scheduleWrite(onUpdate: (vpath: string, content: string) => void): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      const content = this.ytext.toString();
      onUpdate(this.vpath, content);
      this.writeTimer = null;
    }, this.debounceMs);
  }

  /**
   * Disconnect from the document WebSocket and clean up.
   */
  disconnect(): void {
    // Cancel any pending debounced write
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    // Unobserve text changes
    if (this.observerFn) {
      this.ytext.unobserve(this.observerFn);
      this.observerFn = null;
    }

    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    this.ydoc.destroy();
  }
}
