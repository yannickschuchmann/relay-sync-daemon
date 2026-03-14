import PocketBase from "pocketbase";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "../util/logger";
import { captureError, captureMessage } from "../reporting";
import type { Config } from "../config";

const AUTH_FILE = ".relay-auth";
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

export class AuthManager {
  private pb: PocketBase;
  private config: Config;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshFailures = 0;
  private static readonly MAX_REFRESH_FAILURES = 3;

  constructor(config: Config) {
    this.config = config;
    this.pb = new PocketBase(config.authUrl);
  }

  /**
   * Read persisted token from .relay-auth file.
   * Returns the token string or null if not found / unreadable.
   */
  private loadPersistedToken(): string | null {
    const filePath = join(this.config.persistenceDir, AUTH_FILE);
    try {
      if (!existsSync(filePath)) {
        logger.debug("No persisted auth token found");
        return null;
      }
      const token = readFileSync(filePath, "utf-8").trim();
      if (!token) {
        logger.debug("Persisted auth token is empty");
        return null;
      }
      logger.debug("Loaded persisted auth token");
      return token;
    } catch (err) {
      logger.warn("Failed to read persisted auth token", err);
      return null;
    }
  }

  /**
   * Write current token to .relay-auth file for persistence across restarts.
   */
  private persistToken(): void {
    const filePath = join(this.config.persistenceDir, AUTH_FILE);
    writeFileSync(filePath, this.pb.authStore.token, "utf-8");
    logger.debug("Persisted auth token to disk");
  }

  /**
   * Bootstrap authentication from a raw JWT token.
   * Sets the auth store, validates, refreshes, and persists.
   */
  private async bootstrapFromToken(token: string): Promise<void> {
    // Save token into PocketBase auth store with a minimal record model.
    // Some PocketBase SDK versions may not handle null correctly at runtime,
    // so we provide a stub record with the required fields.
    this.pb.authStore.save(token, {
      id: "",
      collectionId: "",
      collectionName: "",
    } as any);

    if (!this.pb.authStore.isValid) {
      throw new Error("Provided auth token is not valid (expired or malformed)");
    }

    // Refresh the token to get a fresh one from the server
    try {
      await this.pb.collection("users").authRefresh();
      logger.info("Auth token refreshed successfully");
    } catch (err) {
      throw new Error(
        `Failed to refresh auth token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Persist the refreshed token
    this.persistToken();
  }

  /**
   * Initialize authentication.
   * Tries persisted token first, then falls back to RELAY_TOKEN env var.
   */
  async initialize(): Promise<void> {
    // Try persisted token first
    const persistedToken = this.loadPersistedToken();
    if (persistedToken) {
      try {
        await this.bootstrapFromToken(persistedToken);
        logger.info("Authenticated from persisted token");
        this.scheduleRefresh();
        return;
      } catch (err) {
        logger.warn(
          "Persisted token failed, trying RELAY_TOKEN env var",
          err,
        );
      }
    }

    // Fall back to RELAY_TOKEN env var
    const envToken = this.config.relayToken;
    if (!envToken) {
      throw new Error(
        "No valid auth token available. Set RELAY_TOKEN or run the auth command.",
      );
    }

    await this.bootstrapFromToken(envToken);
    logger.info("Authenticated from RELAY_TOKEN environment variable");
    this.scheduleRefresh();
  }

  /**
   * Schedule periodic token refresh every 12 hours.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      try {
        await this.pb.collection("users").authRefresh();
        this.persistToken();
        this.refreshFailures = 0;
        logger.info("Auth token refreshed on schedule");
      } catch (err) {
        this.refreshFailures++;
        captureError(err, {
          component: "AuthManager",
          operation: "scheduledRefresh",
          extra: { attempt: this.refreshFailures, maxFailures: AuthManager.MAX_REFRESH_FAILURES },
        });

        if (this.refreshFailures >= AuthManager.MAX_REFRESH_FAILURES) {
          captureMessage(
            `Auth token refresh has failed ${AuthManager.MAX_REFRESH_FAILURES} consecutive times. ` +
              "The token has likely expired permanently (e.g., daemon was offline too long). " +
              "Please provide a fresh RELAY_TOKEN and restart the daemon.",
            "error",
            { component: "AuthManager", operation: "scheduledRefresh" },
          );
          // Dispatch SIGTERM so the coordinator's graceful shutdown handler runs
          // instead of terminating abruptly with process.exit(1).
          process.kill(process.pid, "SIGTERM");
        }
      }
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Get the current auth token.
   */
  getToken(): string {
    return this.pb.authStore.token;
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
