import { loadConfig } from "./config";
import { logger } from "./util/logger";
import { AuthManager } from "./auth/AuthManager";
import { TokenStore } from "./auth/TokenStore";
import { SyncCoordinator } from "./sync/SyncCoordinator";

async function main() {
  const args = process.argv.slice(2);

  // Handle "auth" subcommand for interactive OAuth2 login (future)
  if (args[0] === "auth") {
    const config = loadConfig({ requireToken: false });
    logger.info("OAuth2 CLI auth flow not yet implemented.");
    logger.info(`Auth URL: ${config.authUrl}`);
    process.exit(0);
  }

  const config = loadConfig();
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
    await coordinator.shutdown();
    authManager.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Daemon running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
