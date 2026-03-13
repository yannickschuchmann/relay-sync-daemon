import { loadConfig } from "./config";
import { logger } from "./util/logger";
import { AuthManager } from "./auth/AuthManager";
import { TokenStore } from "./auth/TokenStore";

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

  // TODO (Phase 2): Start SyncCoordinator and perform initial sync
  // TODO (Phase 3): Setup remote watching
  // TODO (Phase 4): Setup local watching
  // TODO (Phase 5): Binary file support

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    authManager.destroy();
    // TODO: coordinator.shutdown() once SyncCoordinator is implemented
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
