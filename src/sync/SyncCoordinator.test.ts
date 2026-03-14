import { describe, test, expect, mock } from "bun:test";
import { SyncCoordinator } from "./SyncCoordinator";
import type { Config } from "../config";
import type { AuthManager } from "../auth/AuthManager";
import type { TokenStore } from "../auth/TokenStore";

/**
 * Integration-level tests for SyncCoordinator.
 * These verify the wiring between sub-coordinators via the public API
 * without requiring real network or filesystem access.
 *
 * Because SyncCoordinator creates internal dependencies (FolderSync,
 * DiskManager, etc.) we focus on construction, accessor consistency,
 * and the shutdown flow.
 */

const UUID1 = "47659acd-052f-4577-b22d-d537c4322e83";
const UUID2 = "1f79edc8-627a-4281-ad82-2485839c8ddf";

function makeConfig(): Config {
  return {
    relayGuid: UUID1,
    folderGuid: UUID2,
    syncDir: "/tmp/sync-test",
    apiUrl: "https://api.example.com",
    authUrl: "https://auth.example.com",
    debounceMs: 100,
    persistenceDir: "/tmp/sync-test/.relay-sync",
  };
}

function makeTokenStore(): TokenStore {
  return {
    getToken: mock(async () => ({
      url: "wss://example.com",
      docId: "doc-id",
      token: "tok",
      folder: UUID2,
    })),
    getCached: mock(() => new Map()),
  } as unknown as TokenStore;
}

function makeAuthManager(): AuthManager {
  return {
    getToken: mock(() => "auth-token"),
    initialize: mock(async () => {}),
    destroy: mock(() => {}),
  } as unknown as AuthManager;
}

describe("SyncCoordinator", () => {
  test("constructor creates a valid instance", () => {
    const coordinator = new SyncCoordinator(
      makeConfig(),
      makeTokenStore(),
      makeAuthManager(),
    );
    expect(coordinator).toBeDefined();
  });

  test("getConnections returns an empty map initially", () => {
    const coordinator = new SyncCoordinator(
      makeConfig(),
      makeTokenStore(),
      makeAuthManager(),
    );
    expect(coordinator.getConnections().size).toBe(0);
  });

  test("getFolderSync returns the FolderSync instance", () => {
    const coordinator = new SyncCoordinator(
      makeConfig(),
      makeTokenStore(),
      makeAuthManager(),
    );
    const fs = coordinator.getFolderSync();
    expect(fs).toBeDefined();
    expect(typeof fs.connect).toBe("function");
    expect(typeof fs.disconnect).toBe("function");
  });

  test("getDiskManager returns the DiskManager instance", () => {
    const coordinator = new SyncCoordinator(
      makeConfig(),
      makeTokenStore(),
      makeAuthManager(),
    );
    const dm = coordinator.getDiskManager();
    expect(dm).toBeDefined();
    expect(typeof dm.writeDocument).toBe("function");
  });

  test("startTokenRefreshLoop and shutdown do not throw", async () => {
    const coordinator = new SyncCoordinator(
      makeConfig(),
      makeTokenStore(),
      makeAuthManager(),
    );
    // Start the token refresh loop (timer-based, won't actually fire in this test)
    coordinator.startTokenRefreshLoop();

    // Shutdown should gracefully clean up all timers and state
    await coordinator.shutdown();
  });

  test("shutdown is idempotent", async () => {
    const coordinator = new SyncCoordinator(
      makeConfig(),
      makeTokenStore(),
      makeAuthManager(),
    );
    await coordinator.shutdown();
    // Second shutdown should also be fine
    await coordinator.shutdown();
  });
});
