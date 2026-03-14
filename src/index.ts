import { loadConfig } from "./config";
import { logger } from "./util/logger";
import { LockFile } from "./util/LockFile";
import { AuthManager } from "./auth/AuthManager";
import { TokenStore } from "./auth/TokenStore";
import { SyncCoordinator } from "./sync/SyncCoordinator";
import {
  setErrorReporter,
  getErrorReporter,
  captureError,
  captureMessage,
  ConsoleReporter,
  CompositeReporter,
  SentryReporter,
} from "./reporting";
import type { ErrorReporter } from "./reporting";

let lockFile: LockFile | null = null;

async function initReporter(): Promise<ErrorReporter> {
  const mode = process.env.ERROR_REPORTER;
  if (mode === "sentry") {
    const sentry = new SentryReporter();
    const composite = new CompositeReporter([new ConsoleReporter(), sentry]);
    await composite.init();
    return composite;
  }
  return new ConsoleReporter();
}

async function main() {
  const args = process.argv.slice(2);

  // Handle "auth" subcommand for interactive OAuth2 login (future)
  if (args[0] === "auth") {
    const config = loadConfig({ requireToken: false });
    logger.info("OAuth2 CLI auth flow not yet implemented.");
    logger.info(`Auth URL: ${config.authUrl}`);
    process.exit(0);
  }

  // Initialize error reporter early
  const reporter = await initReporter();
  setErrorReporter(reporter);

  const config = loadConfig();

  // Acquire lock in persistenceDir to avoid triggering sync events
  lockFile = new LockFile(config.persistenceDir);
  lockFile.acquire();

  logger.info("Starting Relay Sync Daemon");
  logger.info(`Relay: ${config.relayGuid}`);
  logger.info(`Folder: ${config.folderGuid}`);
  logger.info(`Sync dir: ${config.syncDir}`);

  // Phase 1: Authenticate with PocketBase
  const authManager = new AuthManager(config);
  await authManager.initialize();
  logger.info("Authentication successful");

  // Phase 1: Create TokenStore
  const tokenStore = new TokenStore(config, authManager);

  // Phase 2: Start SyncCoordinator and perform initial sync
  const coordinator = new SyncCoordinator(config, tokenStore, authManager);
  await coordinator.initialSync();

  // Start proactive token refresh loop
  coordinator.startTokenRefreshLoop();

  // Phase 3: Setup remote watching
  coordinator.setupRemoteWatching();

  // Phase 4: Setup local file watching
  coordinator.setupLocalWatching();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");

    // Force exit if shutdown hangs
    const forceExitTimer = setTimeout(() => {
      captureMessage("Shutdown timed out after 10s, forcing exit", "error", { component: "main", operation: "shutdown" });
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    await coordinator.shutdown();
    authManager.destroy();
    lockFile?.release();
    await getErrorReporter().flush?.();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Daemon running. Press Ctrl+C to stop.");
}

main().catch(async (err) => {
  captureError(err, { component: "main", operation: "startup" });
  // Release lock on fatal error (best-effort; stale-lock check on next
  // startup will handle it if this fails).
  try {
    lockFile?.release();
  } catch {
    // Best-effort
  }
  await getErrorReporter().flush?.();
  process.exit(1);
});
