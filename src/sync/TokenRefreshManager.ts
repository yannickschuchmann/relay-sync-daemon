import type { Config } from "../config";
import type { TokenStore } from "../auth/TokenStore";
import type { FolderSync } from "./FolderSync";
import type { DocumentSync } from "./DocumentSync";
import { folderS3RN, decodeS3RN } from "../util/s3rn";
import { logger } from "../util/logger";
import { captureError } from "../reporting";

/** How often to check for tokens nearing expiry (milliseconds). */
const TOKEN_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Refresh tokens that expire within this window (milliseconds). */
const TOKEN_REFRESH_WINDOW_MS = 10 * 60_000;

/**
 * Periodically checks for tokens nearing expiry and refreshes them proactively.
 * After refreshing a token it also updates the corresponding YSweetProvider
 * (folder or document) so that the WebSocket connection uses the new credentials.
 */
export class TokenRefreshManager {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: Config,
    private tokenStore: TokenStore,
    private folderSync: FolderSync,
    private getConnections: () => ReadonlyMap<string, DocumentSync>,
  ) {}

  /**
   * Start the periodic refresh loop.
   */
  start(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(async () => {
      try {
        await this.refreshExpiring();
      } catch (err) {
        captureError(err, { component: "TokenRefreshManager", operation: "refreshLoop" });
      }
    }, TOKEN_REFRESH_INTERVAL_MS);
  }

  /**
   * Stop the periodic refresh loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check all cached tokens and refresh any that will expire within
   * TOKEN_REFRESH_WINDOW_MS.
   */
  async refreshExpiring(): Promise<void> {
    const cached = this.tokenStore.getCached();
    const now = Date.now();

    for (const [s3rn, entry] of cached) {
      if (entry.expiryTime - now < TOKEN_REFRESH_WINDOW_MS) {
        logger.info(`Refreshing token for ${s3rn}`);
        try {
          const resource = decodeS3RN(s3rn);
          let docId: string;
          switch (resource.kind) {
            case "folder":
              docId = resource.folderId;
              break;
            case "doc":
              docId = resource.documentId;
              break;
            case "canvas":
              docId = resource.canvasId;
              break;
            case "file":
              docId = resource.fileId;
              break;
            default:
              logger.debug(`Skipping token refresh for unsupported S3RN kind: ${s3rn}`);
              continue;
          }

          const clientToken = await this.tokenStore.getToken(
            s3rn,
            this.config.relayGuid,
            this.config.folderGuid,
            docId,
            { forceRefresh: true },
          );

          // Refresh folder provider if this is the folder token
          const folderProvider = this.folderSync.getProvider();
          const folderS3rnStr = folderS3RN(this.config.relayGuid, this.config.folderGuid);
          if (folderProvider && s3rn === folderS3rnStr) {
            folderProvider.refreshToken(clientToken.url, clientToken.docId, clientToken.token);
          }

          // Refresh document providers
          const connections = this.getConnections();
          for (const [, docSync] of connections) {
            const provider = docSync.getProvider();
            if (provider && docSync.getMeta().id === docId) {
              provider.refreshToken(clientToken.url, clientToken.docId, clientToken.token);
            }
          }
        } catch (err) {
          captureError(err, { component: "TokenRefreshManager", operation: "refreshToken", extra: { s3rn } });
        }
      }
    }
  }
}
