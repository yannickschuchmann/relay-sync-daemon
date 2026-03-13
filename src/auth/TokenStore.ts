import { logger } from "../util/logger";
import { RELAY_VERSION, type ClientToken } from "../protocol/types";
import type { Config } from "../config";
import type { AuthManager } from "./AuthManager";

interface CachedToken {
  clientToken: ClientToken;
  expiryTime: number;
  s3rn: string;
}

/** Buffer time before expiry to consider a token invalid (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60_000;

export class TokenStore {
  private cache: Map<string, CachedToken> = new Map();
  private inFlight: Map<string, Promise<ClientToken>> = new Map();
  private config: Config;
  private authManager: AuthManager;

  constructor(config: Config, authManager: AuthManager) {
    this.config = config;
    this.authManager = authManager;
  }

  /**
   * POST to /token endpoint to fetch a new ClientToken.
   */
  private async fetchToken(s3rn: string, relayId: string, folderId: string, docId: string): Promise<ClientToken> {
    const url = `${this.config.apiUrl}/token`;
    const authToken = this.authManager.getToken();

    logger.debug(`Fetching token for ${s3rn}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "Relay-Version": RELAY_VERSION,
      },
      body: JSON.stringify({
        docId,
        relay: relayId,
        folder: folderId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Token fetch failed (${response.status}): ${text}`,
      );
    }

    const clientToken = (await response.json()) as ClientToken;
    logger.debug(`Token fetched for ${s3rn}`);
    return clientToken;
  }

  /**
   * Check if a cached token is still valid (not expired with 5 min buffer).
   */
  private isValid(cached: CachedToken): boolean {
    return cached.expiryTime > Date.now() + EXPIRY_BUFFER_MS;
  }

  /**
   * Get a ClientToken for the given S3RN.
   * Returns cached token if still valid, otherwise fetches a new one.
   * Deduplicates concurrent requests for the same S3RN.
   */
  async getToken(s3rn: string, relayId: string, folderId: string, docId: string, options?: { forceRefresh?: boolean }): Promise<ClientToken> {
    // Check cache first (skip if force-refreshing)
    if (!options?.forceRefresh) {
      const cached = this.cache.get(s3rn);
      if (cached && this.isValid(cached)) {
        logger.debug(`Using cached token for ${s3rn}`);
        return cached.clientToken;
      }
    }

    // Deduplicate concurrent requests
    const existing = this.inFlight.get(s3rn);
    if (existing) {
      logger.debug(`Deduplicating token request for ${s3rn}`);
      return existing;
    }

    const promise = this.fetchToken(s3rn, relayId, folderId, docId).then((clientToken) => {
      // Cache the token with its expiry time
      const expiryTime = clientToken.expiryTime ?? Date.now() + 60 * 60_000; // default 1 hour
      this.cache.set(s3rn, { clientToken, expiryTime, s3rn });
      this.inFlight.delete(s3rn);
      return clientToken;
    }).catch((err) => {
      this.inFlight.delete(s3rn);
      throw err;
    });

    this.inFlight.set(s3rn, promise);
    return promise;
  }

  /**
   * Expose all cached tokens for the refresh loop to inspect.
   */
  getCached(): ReadonlyMap<string, CachedToken> {
    return this.cache;
  }
}
