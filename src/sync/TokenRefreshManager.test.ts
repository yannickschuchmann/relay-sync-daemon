import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { TokenRefreshManager } from "./TokenRefreshManager";
import type { Config } from "../config";
import type { TokenStore } from "../auth/TokenStore";
import type { FolderSync } from "./FolderSync";
import type { DocumentSync } from "./DocumentSync";

const UUID1 = "47659acd-052f-4577-b22d-d537c4322e83";
const UUID2 = "1f79edc8-627a-4281-ad82-2485839c8ddf";
const DOC_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    relayGuid: UUID1,
    folderGuid: UUID2,
    syncDir: "/tmp/sync",
    apiUrl: "https://api.example.com",
    authUrl: "https://auth.example.com",
    debounceMs: 2000,
    persistenceDir: "/tmp/sync/.relay-sync",
    ...overrides,
  };
}

describe("TokenRefreshManager", () => {
  let manager: TokenRefreshManager;
  let config: Config;
  let mockTokenStore: TokenStore;
  let mockFolderSync: FolderSync;
  let connections: Map<string, DocumentSync>;

  beforeEach(() => {
    config = makeConfig();
    connections = new Map();

    mockTokenStore = {
      getCached: mock(() => new Map()),
      getToken: mock(async () => ({
        url: "wss://example.com",
        docId: "doc-123",
        token: "new-token",
        folder: UUID2,
      })),
    } as unknown as TokenStore;

    mockFolderSync = {
      getProvider: mock(() => null),
    } as unknown as FolderSync;

    manager = new TokenRefreshManager(
      config,
      mockTokenStore,
      mockFolderSync,
      () => connections,
    );
  });

  afterEach(() => {
    manager.stop();
  });

  test("start and stop do not throw", () => {
    expect(() => manager.start()).not.toThrow();
    expect(() => manager.stop()).not.toThrow();
  });

  test("stop is idempotent", () => {
    manager.start();
    expect(() => manager.stop()).not.toThrow();
    expect(() => manager.stop()).not.toThrow();
  });

  test("start can be called multiple times (replaces previous timer)", () => {
    expect(() => {
      manager.start();
      manager.start();
      manager.start();
    }).not.toThrow();
    manager.stop();
  });

  test("refreshExpiring does nothing when no tokens are cached", async () => {
    await manager.refreshExpiring();
    // getToken should not have been called
    expect(mockTokenStore.getToken).not.toHaveBeenCalled();
  });

  test("refreshExpiring skips tokens that are not expiring soon", async () => {
    const farFuture = Date.now() + 30 * 60_000; // 30 minutes from now
    const cachedMap = new Map([
      [
        `s3rn:relay:relay:${UUID1}:folder:${UUID2}`,
        {
          clientToken: { url: "wss://x", docId: "d", token: "t", folder: UUID2 },
          expiryTime: farFuture,
          s3rn: `s3rn:relay:relay:${UUID1}:folder:${UUID2}`,
        },
      ],
    ]);
    (mockTokenStore.getCached as ReturnType<typeof mock>).mockReturnValue(cachedMap);

    await manager.refreshExpiring();
    expect(mockTokenStore.getToken).not.toHaveBeenCalled();
  });

  test("refreshExpiring refreshes tokens expiring within the window", async () => {
    const soonExpiry = Date.now() + 5 * 60_000; // 5 minutes from now (within 10 min window)
    const s3rn = `s3rn:relay:relay:${UUID1}:folder:${UUID2}`;
    const cachedMap = new Map([
      [
        s3rn,
        {
          clientToken: { url: "wss://x", docId: UUID2, token: "old", folder: UUID2 },
          expiryTime: soonExpiry,
          s3rn,
        },
      ],
    ]);
    (mockTokenStore.getCached as ReturnType<typeof mock>).mockReturnValue(cachedMap);

    await manager.refreshExpiring();
    expect(mockTokenStore.getToken).toHaveBeenCalledTimes(1);
  });

  test("refreshExpiring refreshes folder provider when folder token is refreshed", async () => {
    const soonExpiry = Date.now() + 5 * 60_000;
    const s3rn = `s3rn:relay:relay:${UUID1}:folder:${UUID2}`;
    const cachedMap = new Map([
      [
        s3rn,
        {
          clientToken: { url: "wss://x", docId: UUID2, token: "old", folder: UUID2 },
          expiryTime: soonExpiry,
          s3rn,
        },
      ],
    ]);
    (mockTokenStore.getCached as ReturnType<typeof mock>).mockReturnValue(cachedMap);

    const mockProvider = { refreshToken: mock(() => {}) };
    (mockFolderSync.getProvider as ReturnType<typeof mock>).mockReturnValue(mockProvider);

    await manager.refreshExpiring();
    expect(mockProvider.refreshToken).toHaveBeenCalledWith(
      "wss://example.com",
      "doc-123",
      "new-token",
    );
  });

  test("refreshExpiring refreshes document providers for matching docIds", async () => {
    const soonExpiry = Date.now() + 5 * 60_000;
    const s3rn = `s3rn:relay:relay:${UUID1}:folder:${UUID2}:doc:${DOC_UUID}`;
    const cachedMap = new Map([
      [
        s3rn,
        {
          clientToken: { url: "wss://x", docId: DOC_UUID, token: "old", folder: UUID2 },
          expiryTime: soonExpiry,
          s3rn,
        },
      ],
    ]);
    (mockTokenStore.getCached as ReturnType<typeof mock>).mockReturnValue(cachedMap);

    const mockDocProvider = { refreshToken: mock(() => {}) };
    const mockDocSync = {
      getProvider: mock(() => mockDocProvider),
      getMeta: mock(() => ({ id: DOC_UUID, type: "markdown", version: 0 })),
    } as unknown as DocumentSync;

    connections.set("/test.md", mockDocSync);

    await manager.refreshExpiring();
    expect(mockDocProvider.refreshToken).toHaveBeenCalledWith(
      "wss://example.com",
      "doc-123",
      "new-token",
    );
  });

  test("refreshExpiring handles token fetch errors gracefully", async () => {
    const soonExpiry = Date.now() + 5 * 60_000;
    const s3rn = `s3rn:relay:relay:${UUID1}:folder:${UUID2}`;
    const cachedMap = new Map([
      [
        s3rn,
        {
          clientToken: { url: "wss://x", docId: UUID2, token: "old", folder: UUID2 },
          expiryTime: soonExpiry,
          s3rn,
        },
      ],
    ]);
    (mockTokenStore.getCached as ReturnType<typeof mock>).mockReturnValue(cachedMap);
    (mockTokenStore.getToken as ReturnType<typeof mock>).mockRejectedValue(
      new Error("network error"),
    );

    // Should not throw
    await manager.refreshExpiring();
  });
});
