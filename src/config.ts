import { mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { logger } from "./util/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Config {
  /** PocketBase JWT for bootstrap auth. */
  relayToken?: string;
  /** UUID of the relay. */
  relayGuid: string;
  /** UUID of the shared folder. */
  folderGuid: string;
  /** Absolute path to the local sync directory. */
  syncDir: string;
  /** Relay API base URL. */
  apiUrl: string;
  /** PocketBase auth base URL. */
  authUrl: string;
  /** Debounce delay in milliseconds for file change events. */
  debounceMs: number;
  /** Directory for persisted Y.Doc state and auth tokens. */
  persistenceDir: string;
}

export interface LoadConfigOptions {
  /** If true, RELAY_TOKEN is not required (used for CLI auth subcommand). */
  requireToken?: boolean;
}

/**
 * Load and validate configuration from environment variables.
 * Throws if required variables are missing or invalid.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const { requireToken = true } = options;

  const relayGuid = requireEnv("RELAY_GUID");
  const folderGuid = requireEnv("FOLDER_GUID");
  const syncDir = requireEnv("SYNC_DIR");

  // Validate UUIDs
  if (!UUID_REGEX.test(relayGuid)) {
    throw new Error(`RELAY_GUID is not a valid UUID: "${relayGuid}"`);
  }
  if (!UUID_REGEX.test(folderGuid)) {
    throw new Error(`FOLDER_GUID is not a valid UUID: "${folderGuid}"`);
  }

  // Resolve syncDir to absolute path
  const resolvedSyncDir = resolve(syncDir);

  // Ensure syncDir exists
  if (!existsSync(resolvedSyncDir)) {
    logger.info(`Creating sync directory: ${resolvedSyncDir}`);
    mkdirSync(resolvedSyncDir, { recursive: true });
  }

  const apiUrl = process.env.API_URL ?? "https://api.system3.md";
  const authUrl = process.env.AUTH_URL ?? "https://auth.system3.md";
  const debounceMs = parseInt(process.env.DEBOUNCE_MS ?? "2000", 10);
  const persistenceDir = resolve(
    process.env.PERSISTENCE_DIR ?? `${resolvedSyncDir}/.relay-sync`,
  );

  // Ensure persistence directory exists
  if (!existsSync(persistenceDir)) {
    mkdirSync(persistenceDir, { recursive: true });
  }

  const relayToken = process.env.RELAY_TOKEN;
  if (requireToken && !relayToken) {
    // Not a hard error here -- AuthManager will try .relay-auth first
    logger.debug("RELAY_TOKEN not set; will attempt persisted auth");
  }

  return {
    relayToken: relayToken || undefined,
    relayGuid,
    folderGuid,
    syncDir: resolvedSyncDir,
    apiUrl,
    authUrl,
    debounceMs: Number.isNaN(debounceMs) ? 2000 : debounceMs,
    persistenceDir,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}
