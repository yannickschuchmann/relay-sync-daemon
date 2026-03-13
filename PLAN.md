# Relay Sync Daemon - Implementation Plan

A standalone TypeScript/Bun daemon that connects to the Relay.md collaboration network and syncs a shared folder's documents as files to a local directory. Designed to run headlessly on a VPS.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Dependencies](#dependencies)
3. [Project Structure](#project-structure)
4. [Phase 1: Auth + Folder Connection](#phase-1-auth--folder-connection)
5. [Phase 2: Download Documents](#phase-2-download-documents)
6. [Phase 3: Watch Remote Changes](#phase-3-watch-remote-changes)
7. [Phase 4: Watch Local Changes](#phase-4-watch-local-changes--push-to-relay)
8. [Phase 5: Binary File Support](#phase-5-binary-file-support)
9. [Configuration](#configuration)
10. [Error Handling & Resilience](#error-handling--resilience)
11. [Risks & Open Questions](#risks--open-questions)

---

## Architecture Overview

```
+-------------------+         +------------------+         +-------------------+
|                   |  Yjs    |                  |  Yjs    |                   |
|  Relay Server     |<------->|  Sync Daemon     |<------->|  Local Disk       |
|  (y-sweet WS)     |  sync   |  (Bun process)   |  r/w    |  (SYNC_DIR)       |
|                   | protocol|                  |         |                   |
+-------------------+         +------------------+         +-------------------+
        ^                           |     ^
        |                           |     |
   PocketBase Auth             chokidar   |
   + API token exchange        watches    |
                               files      |
                                          |
                              diff-match-patch
                              for text diffs
```

---

## Known Configuration

These values are from the user's actual installed Relay.md Obsidian plugin:

| Setting | Value |
|---------|-------|
| Relay GUID | `47659acd-052f-4577-b22d-d537c4322e83` |
| Folder GUID | `1f79edc8-627a-4281-ad82-2485839c8ddf` |
| Shared Folder Path | `Digital Dignity` |
| Plugin Version | `0.7.4` |
| Login Provider | Google |
| Binary sync: images | `true` |
| Binary sync: audio | `true` |
| Binary sync: videos | `true` |
| Binary sync: pdfs | `true` |
| Binary sync: otherTypes | `false` |
| PocketBase auth store key format | `pocketbase_auth_{vaultName}` (e.g., `pocketbase_auth_Digital Dignity`) |

---

**Data flow:**

1. Daemon authenticates with PocketBase, gets JWT
2. Exchanges JWT for ClientToken (WebSocket URL + short-lived token) via `POST /token`
3. Connects to the folder's Y.Doc via WebSocket using the y-sweet sync protocol
4. Reads `filemeta_v0` Y.Map to discover all files in the shared folder
5. For each document, fetches a separate ClientToken and connects its own Y.Doc
6. Extracts text from `Y.Text("contents")` and writes to disk
7. Watches both remote Y.Doc changes and local filesystem changes, bidirectionally syncing

**Key Relay Concepts:**

- **Shared Folder** = one Y.Doc whose `filemeta_v0` Y.Map tracks all files. Keys are virtual paths (e.g., `notes/todo.md`), values are `Meta` objects.
- **Document** = a separate Y.Doc per file, with a `Y.Text("contents")` containing raw markdown.
- **Binary files** (images, PDFs, etc.) use hash-based content addressing via presigned S3 URLs.
- **S3RN** = resource name format: `s3rn:relay:relay:{relayId}:folder:{folderId}:doc:{docId}` for markdown documents, or `s3rn:...:canvas:{canvasId}` for canvas documents. Note: canvas uses `canvas:` not `doc:` in the S3RN.
- **ClientToken** = `{ url, docId, folder, token, expiryTime }` -- the `url` is the WebSocket base, `token` is appended as a query param.

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `yjs` | ^13.x | CRDT shared data types (Y.Doc, Y.Text, Y.Map) |
| `y-protocols` | ^1.x | Yjs sync and awareness wire protocol (sync messages, auth) |
| `lib0` | ^0.2.x | Binary encoding/decoding utilities required by y-protocols |
| `pocketbase` | ^0.26.x | PocketBase JS SDK for OAuth2 auth, token refresh, code_exchange polling |
| `chokidar` | ^4.x | Cross-platform file watching (more reliable than Bun's native fs.watch) |
| `diff-match-patch` | ^1.x | Compute text diffs to translate local edits into Y.Text operations |
| `jose` | ^5.x | JWT decoding/verification for token expiry checking |

**Dev dependencies:**

| Package | Purpose |
|---------|---------|
| `typescript` | Type checking (Bun runs TS natively) |
| `@types/diff-match-patch` | Type definitions |
| `bun-types` | Bun API type definitions |

**Why these choices:**

- **chokidar over Bun.watch**: Bun's native `fs.watch` is functional but chokidar handles edge cases better (atomic writes, editor temp files, `awaitWriteFinish` for large files, recursive watching with depth control). Chokidar v4 is ESM-only and lightweight.
- **diff-match-patch**: Same library used by the existing Relay Obsidian plugin (see `y-diffMatchPatch.ts`). Google's battle-tested text diffing, originally built for Google Docs.
- **pocketbase SDK**: Official SDK handles auth store management, token refresh, and collection queries. We'll use it directly rather than raw HTTP for auth flows.
- **jose**: Already used in the existing codebase for JWT operations. Needed to check token expiry times.

---

## Project Structure

```
relay-sync-daemon/
  package.json
  tsconfig.json
  bunfig.toml
  .env.example
  src/
    index.ts                  # Entry point, CLI arg parsing, main loop
    config.ts                 # Environment variable loading & validation
    auth/
      AuthManager.ts          # PocketBase auth lifecycle (bootstrap, refresh, OAuth2 CLI)
      TokenStore.ts           # ClientToken cache, refresh scheduling, expiry tracking
    sync/
      FolderSync.ts           # Folder Y.Doc connection, filemeta_v0 observation
      DocumentSync.ts         # Individual document Y.Doc connection + text extraction
      BinarySync.ts           # Binary file upload/download via CAS endpoints
      SyncCoordinator.ts      # Orchestrates all sync connections, manages lifecycle
    protocol/
      YSweetProvider.ts       # WebSocket provider for Yjs (adapted from existing plugin)
      messages.ts             # Message type constants & handler registration
      types.ts                # ClientToken, FileToken, Meta, SyncType interfaces
    fs/
      DiskManager.ts          # Read/write files to SYNC_DIR, ensure directories exist
      FileWatcher.ts          # chokidar wrapper, debounced event emission
    diff/
      TextDiff.ts             # diff-match-patch integration: disk text -> Y.Text ops
    persistence/
      DocStore.ts             # Persist Y.Doc state to disk (binary snapshots)
    util/
      s3rn.ts                 # S3RN encode/decode (ported from existing codebase)
      hash.ts                 # SHA256 hashing for binary files
      logger.ts               # Structured logging with levels
      debounce.ts             # Debounce utility
```

---

## Phase 1: Auth + Folder Connection

### 1.1 Configuration Loading (`config.ts`)

```typescript
interface Config {
  relayToken?: string;       // RELAY_TOKEN: PocketBase JWT (for bootstrap)
  relayGuid: string;         // RELAY_GUID: UUID of the relay
  folderGuid: string;        // FOLDER_GUID: UUID of the shared folder
  syncDir: string;           // SYNC_DIR: absolute path to local directory
  apiUrl: string;            // API_URL: default https://api.system3.md
  authUrl: string;           // AUTH_URL: default https://auth.system3.md
  debounceMs: number;        // DEBOUNCE_MS: default 2000
  persistenceDir?: string;   // PERSISTENCE_DIR: for Y.Doc snapshots, default SYNC_DIR/.relay-sync
}

function loadConfig(): Config {
  // Load from process.env, validate required fields, set defaults
  // Validate UUIDs for relayGuid and folderGuid
  // Ensure syncDir exists (create if not)
}
```

### 1.2 Auth Manager (`auth/AuthManager.ts`)

Two auth strategies:

**Strategy 1: Token Bootstrap (primary for daemon use)**

```typescript
class AuthManager {
  private pb: PocketBase;
  private token: string;
  private refreshTimer: Timer | null = null;
  private authFilePath: string;

  constructor(authUrl: string, persistenceDir: string) {
    this.pb = new PocketBase(authUrl);
    this.authFilePath = join(persistenceDir, ".relay-auth");
  }

  // Initialize auth: try persisted token first, then fall back to env var
  async initialize(envToken?: string): Promise<void> {
    // 1. Try loading persisted token from .relay-auth file
    const persistedToken = await this.loadPersistedToken();
    if (persistedToken) {
      try {
        await this.bootstrapFromToken(persistedToken);
        logger.info("Authenticated from persisted .relay-auth file");
        return;
      } catch {
        logger.warn("Persisted token invalid, falling back to RELAY_TOKEN env var");
      }
    }

    // 2. Fall back to RELAY_TOKEN env var (one-time bootstrap)
    if (envToken) {
      await this.bootstrapFromToken(envToken);
      logger.info("Authenticated via RELAY_TOKEN bootstrap");
      return;
    }

    throw new Error("No valid auth token found. Provide RELAY_TOKEN env var for initial bootstrap.");
  }

  // Bootstrap from a raw PocketBase JWT
  async bootstrapFromToken(token: string): Promise<void> {
    // Manually set the auth store with the provided JWT
    // The token is a PocketBase JWT, not a ClientToken
    this.pb.authStore.save(token, null);

    if (!this.pb.authStore.isValid) {
      throw new Error("Provided token is invalid or expired");
    }

    // Refresh immediately to validate and get fresh token
    await this.pb.collection("users").authRefresh();
    this.token = this.pb.authStore.token;

    // Persist the fresh token so future restarts don't need RELAY_TOKEN
    await this.persistToken(this.token);

    this.scheduleRefresh();
  }

  // Schedule token refresh every 12 hours (tokens valid ~14 days)
  private scheduleRefresh(): void {
    this.refreshTimer = setInterval(async () => {
      try {
        await this.pb.collection("users").authRefresh();
        this.token = this.pb.authStore.token;
        await this.persistToken(this.token);
        logger.info("Auth token refreshed and persisted");
      } catch (err) {
        logger.error("Token refresh failed:", err);
      }
    }, 12 * 60 * 60 * 1000); // 12 hours
  }

  // Persist token to .relay-auth file for self-sustaining auth across restarts
  private async persistToken(token: string): Promise<void> {
    try {
      await mkdir(dirname(this.authFilePath), { recursive: true });
      await Bun.write(this.authFilePath, token);
    } catch (err) {
      logger.warn("Failed to persist auth token:", err);
    }
  }

  // Load previously persisted token
  private async loadPersistedToken(): Promise<string | null> {
    try {
      const file = Bun.file(this.authFilePath);
      if (await file.exists()) {
        return (await file.text()).trim();
      }
    } catch { /* no persisted token */ }
    return null;
  }

  getToken(): string {
    return this.pb.authStore.token;
  }
}
```

The auth flow is designed for self-sustaining operation: a one-time `RELAY_TOKEN` env var bootstrap leads to a persisted `.relay-auth` file that is refreshed automatically. Subsequent daemon restarts will use the persisted token without needing the env var.

**Strategy 2: CLI OAuth2 Flow (Future - not implemented in Phase 1)**

For initial token acquisition on a headless VPS, run `relay-sync auth`:

```typescript
async cliOAuth2Flow(): Promise<void> {
  // 1. List auth methods to get provider info
  const authMethods = await this.pb.collection("users").listAuthMethods();
  const provider = authMethods.authProviders.find(p => p.name === "google");

  // 2. Build the OAuth2 URL
  const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
  const authUrl = provider.authUrl + redirectUrl;

  // 3. Print URL for user to open in browser
  console.log(`Open this URL in your browser:\n\n  ${authUrl}\n`);
  console.log("Waiting for authentication...");

  // 4. Poll code_exchange collection
  const statePrefix = provider.state.slice(0, 15);
  let authData: RecordAuthResponse;
  for (let i = 0; i < 120; i++) { // 2 minute timeout
    try {
      const record = await this.pb.collection("code_exchange").getOne(statePrefix);
      if (record) {
        authData = await this.pb.collection("users").authWithOAuth2Code(
          provider.name,
          record.code,
          provider.codeVerifier,
          redirectUrl,
        );
        break;
      }
    } catch { /* not yet available */ }
    await Bun.sleep(1000);
  }

  // 5. Save token to .env or stdout
  console.log(`\nAuthenticated! Set this env var:\n`);
  console.log(`RELAY_TOKEN=${this.pb.authStore.token}`);
}
```

### 1.3 Token Store (`auth/TokenStore.ts`)

Manages ClientTokens for WebSocket connections. Each Y.Doc (folder or document) needs its own ClientToken.

```typescript
interface CachedToken {
  clientToken: ClientToken;
  expiryTime: number;
  s3rn: string;
}

class TokenStore {
  private cache = new Map<string, CachedToken>();
  private activeRequests = new Map<string, Promise<ClientToken>>();

  constructor(
    private authManager: AuthManager,
    private apiUrl: string,
  ) {}

  async getToken(s3rn: string, relayId: string, folderId: string, docId: string): Promise<ClientToken> {
    const cached = this.cache.get(s3rn);
    if (cached && this.isValid(cached)) {
      return cached.clientToken;
    }

    // Deduplicate concurrent requests for the same token
    const existing = this.activeRequests.get(s3rn);
    if (existing) return existing;

    const promise = this.fetchToken(relayId, folderId, docId);
    this.activeRequests.set(s3rn, promise);

    try {
      const token = await promise;
      this.cache.set(s3rn, {
        clientToken: token,
        expiryTime: token.expiryTime || Date.now() + 3600_000,
        s3rn,
      });
      return token;
    } finally {
      this.activeRequests.delete(s3rn);
    }
  }

  private async fetchToken(relayId: string, folderId: string, docId: string): Promise<ClientToken> {
    const response = await fetch(`${this.apiUrl}/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authManager.getToken()}`,
        "Content-Type": "application/json",
        "Relay-Version": RELAY_VERSION,
      },
      body: JSON.stringify({ docId, relay: relayId, folder: folderId }),
    });

    if (!response.ok) {
      throw new Error(`Token fetch failed: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<ClientToken>;
  }

  private isValid(cached: CachedToken): boolean {
    // Refresh 5 minutes before expiry
    return cached.expiryTime > Date.now() + 5 * 60_000;
  }
}
```

### 1.4 Folder Connection (`sync/FolderSync.ts`)

```typescript
class FolderSync {
  private ydoc: Y.Doc;
  private provider: YSweetProvider;
  private filemeta: Y.Map<Meta>;

  constructor(
    private config: Config,
    private tokenStore: TokenStore,
  ) {
    this.ydoc = new Y.Doc();
    this.filemeta = this.ydoc.getMap<Meta>("filemeta_v0");

    // Note: The folder Y.Doc also contains legacy Y.Maps "docs" and "users".
    // The daemon should be aware of these but only needs to read from "filemeta_v0".
  }

  async connect(): Promise<void> {
    const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}`;
    const clientToken = await this.tokenStore.getToken(
      s3rn,
      this.config.relayGuid,
      this.config.folderGuid,
      this.config.folderGuid, // For folders, docId = folderId
    );

    // Connect via WebSocket
    // URL format: {clientToken.url}/{clientToken.docId}?token={clientToken.token}
    this.provider = new YSweetProvider(
      clientToken.url,
      clientToken.docId,
      this.ydoc,
      {
        params: { token: clientToken.token },
        disableBc: true,   // No broadcast channel needed server-side
        connect: true,
      },
    );

    // Set awareness state identifying this client as a daemon/bot
    this.provider.awareness.setLocalStateField("user", {
      name: "relay-sync-daemon",
      color: "#888888",
      isBot: true,
    });

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      if (this.provider.synced) return resolve();
      this.provider.once("synced", () => resolve());
    });

    logger.info(`Connected to folder. Found ${this.filemeta.size} files.`);
  }

  listFiles(): Map<string, Meta> {
    const files = new Map<string, Meta>();
    this.filemeta.forEach((meta, path) => {
      files.set(path, meta);
    });
    return files;
  }
}
```

### 1.5 WebSocket Provider (`protocol/YSweetProvider.ts`)

Port the existing `YSweetProvider` from `/context/Relay/src/client/provider.ts` with these modifications:

- Remove browser-specific code (`window.addEventListener`, broadcast channel)
- Remove Obsidian-specific imports
- Use Bun's native `WebSocket` (standard API, supports custom headers)
- Add token refresh capability via `refreshToken()` method
- Keep the y-protocols sync message handling intact (sync step 1/2, awareness, auth)
- Keep exponential backoff reconnection logic
- Simplify awareness handling (daemon doesn't need cursor positions)

Key message flow on connect:
```
Client                          Server
  |--- SyncStep1 (state vector) -->|
  |<-- SyncStep2 (full diff) ------|
  |<-- SyncStep1 (state vector) ---|
  |--- SyncStep2 (full diff) ----->|
  |                                |
  |<-- Update (incremental) ------>|  (bidirectional from here on)
```

### 1.6 Token Refresh for WebSocket Connections

ClientTokens expire in ~1 hour. The daemon must refresh tokens before expiry and reconnect WebSockets with new URLs:

```typescript
class SyncCoordinator {
  private refreshInterval: Timer;

  startTokenRefreshLoop(): void {
    // Check every 5 minutes for tokens nearing expiry
    this.refreshInterval = setInterval(async () => {
      for (const [s3rn, connection] of this.connections) {
        const cached = this.tokenStore.getCached(s3rn);
        if (cached && cached.expiryTime < Date.now() + 10 * 60_000) {
          try {
            const newToken = await this.tokenStore.getToken(/* ... force refresh ... */);
            connection.provider.refreshToken(newToken.url, newToken.docId, newToken.token);
            logger.debug(`Refreshed token for ${s3rn}`);
          } catch (err) {
            logger.error(`Token refresh failed for ${s3rn}:`, err);
          }
        }
      }
    }, 5 * 60_000);
  }
}
```

---

## Phase 2: Download Documents

### 2.1 Document Sync (`sync/DocumentSync.ts`)

For each text-based document (markdown or canvas) discovered in `filemeta_v0`:

```typescript
class DocumentSync {
  private ydoc: Y.Doc;
  private provider: YSweetProvider;
  private ytext: Y.Text;

  constructor(
    private vpath: string,     // e.g., "notes/todo.md"
    private meta: DocumentMeta,
    private config: Config,
    private tokenStore: TokenStore,
  ) {
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("contents");
  }

  async connect(): Promise<void> {
    // Canvas uses "canvas:" in the S3RN, documents use "doc:"
    const typeSegment = this.meta.type === SyncType.Canvas ? "canvas" : "doc";
    const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:${typeSegment}:${this.meta.id}`;
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
        params: { token: clientToken.token },
        disableBc: true,
        connect: true,
      },
    );

    // Set awareness state identifying this client as a daemon/bot
    this.provider.awareness.setLocalStateField("user", {
      name: "relay-sync-daemon",
      color: "#888888",
      isBot: true,
    });

    await new Promise<void>((resolve) => {
      if (this.provider.synced) return resolve();
      this.provider.once("synced", () => resolve());
    });
  }

  getContent(): string {
    return this.ytext.toString();
  }

  disconnect(): void {
    this.provider.destroy();
  }
}
```

### 2.2 Disk Manager (`fs/DiskManager.ts`)

```typescript
import { mkdir, writeFile, readFile, unlink, rename, stat } from "fs/promises";
import { dirname, join } from "path";

class DiskManager {
  constructor(private syncDir: string) {}

  async writeDocument(vpath: string, content: string): Promise<void> {
    const fullPath = join(this.syncDir, vpath);
    await mkdir(dirname(fullPath), { recursive: true });

    // Write atomically via temp file to avoid triggering watcher with partial writes
    const tmpPath = fullPath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, fullPath);
  }

  async readDocument(vpath: string): Promise<string> {
    const fullPath = join(this.syncDir, vpath);
    return readFile(fullPath, "utf-8");
  }

  async deleteDocument(vpath: string): Promise<void> {
    const fullPath = join(this.syncDir, vpath);
    await unlink(fullPath).catch(() => {}); // Ignore if already deleted
  }

  async writeBinary(vpath: string, content: ArrayBuffer): Promise<void> {
    const fullPath = join(this.syncDir, vpath);
    await mkdir(dirname(fullPath), { recursive: true });
    const tmpPath = fullPath + ".tmp";
    await Bun.write(tmpPath, content);
    await rename(tmpPath, fullPath);
  }

  async readBinary(vpath: string): Promise<ArrayBuffer> {
    const fullPath = join(this.syncDir, vpath);
    const file = Bun.file(fullPath);
    return file.arrayBuffer();
  }

  toAbsolute(vpath: string): string {
    return join(this.syncDir, vpath);
  }

  toVpath(absolutePath: string): string {
    return absolutePath.slice(this.syncDir.length + 1);
  }
}
```

### 2.3 Initial Download Orchestration

```typescript
// In SyncCoordinator.ts
async initialSync(): Promise<void> {
  await this.folderSync.connect();
  const files = this.folderSync.listFiles();

  // Connect to each document, rate-limited to avoid overwhelming the server
  // The TokenStore already enforces maxConnections
  const documents = [...files.entries()]
    .filter(([, meta]) => isTextType(meta.type)); // Includes both Document and Canvas

  logger.info(`Syncing ${documents.length} documents...`);

  // Process in batches of 5 (matching maxConnections)
  for (let i = 0; i < documents.length; i += 5) {
    const batch = documents.slice(i, i + 5);
    await Promise.all(
      batch.map(async ([vpath, meta]) => {
        const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
        await docSync.connect();
        const content = docSync.getContent();
        await this.diskManager.writeDocument(vpath, content);
        this.connections.set(vpath, docSync);
        logger.info(`Synced: ${vpath} (${content.length} chars)`);
      })
    );
  }

  logger.info("Initial sync complete.");
}
```

### 2.4 CRDT Persistence (`persistence/DocStore.ts`)

Persist Y.Doc state to survive daemon restarts without re-downloading everything:

```typescript
class DocStore {
  constructor(private persistenceDir: string) {}

  async save(docId: string, ydoc: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(ydoc);
    const path = join(this.persistenceDir, `${docId}.ystate`);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, state);
  }

  async load(docId: string, ydoc: Y.Doc): Promise<boolean> {
    const path = join(this.persistenceDir, `${docId}.ystate`);
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const state = new Uint8Array(await file.arrayBuffer());
        Y.applyUpdate(ydoc, state);
        return true;
      }
    } catch { /* first run, no persisted state */ }
    return false;
  }
}
```

On startup, load persisted state before connecting. The Yjs sync protocol handles diffing via state vectors -- it will only exchange the delta between the persisted state and the server's current state.

Persistence is saved periodically (every 30s) and on clean shutdown.

---

## Phase 3: Watch Remote Changes

### 3.1 Observing Document Text Changes

```typescript
// In DocumentSync.ts
observeRemoteChanges(onUpdate: (vpath: string, content: string) => void): void {
  this.ytext.observe((event, transaction) => {
    // Skip changes we originated (from local file edits)
    if (transaction.origin === "local-edit") return;

    // Debounce to batch rapid remote edits
    this.scheduleWrite(onUpdate);
  });
}

private writeTimer: Timer | null = null;

private scheduleWrite(onUpdate: (vpath: string, content: string) => void): void {
  if (this.writeTimer) clearTimeout(this.writeTimer);
  this.writeTimer = setTimeout(() => {
    const content = this.ytext.toString();
    onUpdate(this.vpath, content);
    this.writeTimer = null;
  }, this.debounceMs);
}
```

### 3.2 Observing Folder Metadata Changes

Watch `filemeta_v0` for file additions, deletions, and renames:

```typescript
// In FolderSync.ts
observeMetaChanges(handlers: {
  onFileAdded: (vpath: string, meta: Meta) => void;
  onFileDeleted: (vpath: string) => void;
  onFileUpdated: (vpath: string, meta: Meta) => void;
}): void {
  this.filemeta.observe((event) => {
    event.changes.keys.forEach((change, key) => {
      const vpath = key;
      switch (change.action) {
        case "add":
          handlers.onFileAdded(vpath, this.filemeta.get(vpath)!);
          break;
        case "delete":
          handlers.onFileDeleted(vpath);
          break;
        case "update":
          // Could be a rename (delete old + add new) or metadata update
          handlers.onFileUpdated(vpath, this.filemeta.get(vpath)!);
          break;
      }
    });
  });
}
```

### 3.3 Handling New/Deleted Documents in SyncCoordinator

```typescript
// In SyncCoordinator.ts
setupRemoteWatching(): void {
  this.folderSync.observeMetaChanges({
    onFileAdded: async (vpath, meta) => {
      if (meta.type === SyncType.Document) {
        logger.info(`Remote file added: ${vpath}`);
        const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
        await docSync.connect();
        const content = docSync.getContent();
        await this.diskManager.writeDocument(vpath, content);
        this.connections.set(vpath, docSync);
        docSync.observeRemoteChanges((p, c) => this.onRemoteDocChange(p, c));
      }
      // Binary files handled in Phase 5
    },

    onFileDeleted: async (vpath) => {
      logger.info(`Remote file deleted: ${vpath}`);
      const conn = this.connections.get(vpath);
      if (conn) {
        conn.disconnect();
        this.connections.delete(vpath);
      }
      await this.diskManager.deleteDocument(vpath);
    },

    onFileUpdated: async (vpath, meta) => {
      logger.info(`Remote metadata updated: ${vpath}`);
      // Handle hash changes for binary files (Phase 5)
    },
  });
}

// Flag to suppress watcher events for writes we initiate
private suppressedPaths = new Set<string>();

async onRemoteDocChange(vpath: string, content: string): Promise<void> {
  this.suppressedPaths.add(vpath);
  await this.diskManager.writeDocument(vpath, content);
  // Remove suppression after a delay to let the watcher event pass
  setTimeout(() => this.suppressedPaths.delete(vpath), 500);
}
```

---

## Phase 4: Watch Local Changes -> Push to Relay

### 4.1 File Watcher (`fs/FileWatcher.ts`)

```typescript
import chokidar from "chokidar";
import { join, relative } from "path";

class FileWatcher {
  private watcher: chokidar.FSWatcher;

  constructor(
    private syncDir: string,
    private handlers: {
      onFileChanged: (vpath: string) => void;
      onFileAdded: (vpath: string) => void;
      onFileDeleted: (vpath: string) => void;
    },
    private isSupressed: (vpath: string) => boolean,
  ) {}

  start(): void {
    this.watcher = chokidar.watch(this.syncDir, {
      ignored: [
        /(^|[\/\\])\../,          // dotfiles/dotfolders
        /\.tmp$/,                  // temp files from atomic writes
        /\.ystate$/,               // our persistence files
        "**/node_modules/**",
      ],
      persistent: true,
      ignoreInitial: true,         // Don't fire for existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: 1000,  // Wait for writes to stabilize
        pollInterval: 100,
      },
      atomic: true,                // Handle atomic saves (write to tmp + rename)
    });

    this.watcher
      .on("change", (absPath) => {
        const vpath = relative(this.syncDir, absPath);
        if (this.isSupressed(vpath)) return;
        this.handlers.onFileChanged(vpath);
      })
      .on("add", (absPath) => {
        const vpath = relative(this.syncDir, absPath);
        if (this.isSupressed(vpath)) return;
        this.handlers.onFileAdded(vpath);
      })
      .on("unlink", (absPath) => {
        const vpath = relative(this.syncDir, absPath);
        if (this.isSupressed(vpath)) return;
        this.handlers.onFileDeleted(vpath);
      })
      .on("error", (err) => {
        logger.error("File watcher error:", err);
      })
      .on("ready", () => {
        logger.info("File watcher ready");
      });
  }

  async stop(): Promise<void> {
    await this.watcher.close();
  }
}
```

### 4.2 Text Diffing (`diff/TextDiff.ts`)

Port the existing `y-diffMatchPatch.ts` from the Relay plugin. This is the core of local-to-remote sync for text documents:

```typescript
import * as Y from "yjs";
import { diff_match_patch, type Diff } from "diff-match-patch";

/**
 * Apply a local file's content to a Y.Doc by computing minimal diffs.
 * This translates a full-text replacement into granular Y.Text insert/delete ops,
 * preserving the CRDT history and enabling proper merging with concurrent edits.
 */
export function applyTextToYDoc(ydoc: Y.Doc, newContent: string): void {
  const ytext = ydoc.getText("contents");
  const currentContent = ytext.toString();

  // No changes
  if (currentContent === newContent) return;

  const dmp = new diff_match_patch();
  const diffs: Diff[] = dmp.diff_main(currentContent, newContent);
  dmp.diff_cleanupSemantic(diffs);

  if (diffs.length === 0) return;

  // Apply diffs inside a transaction, tagged with origin so remote
  // observers can distinguish local edits from remote ones
  ydoc.transact(() => {
    let cursor = 0;
    for (const [operation, text] of diffs) {
      switch (operation) {
        case 1:  // Insert
          ytext.insert(cursor, text);
          cursor += text.length;
          break;
        case 0:  // Equal
          cursor += text.length;
          break;
        case -1: // Delete
          ytext.delete(cursor, text.length);
          break;
      }
    }
  }, "local-edit");  // Transaction origin marker
}
```

### 4.3 Local Change Handling in SyncCoordinator

```typescript
// In SyncCoordinator.ts

// Debounce map: vpath -> timer
private localChangeTimers = new Map<string, Timer>();

setupLocalWatching(): void {
  this.fileWatcher = new FileWatcher(
    this.config.syncDir,
    {
      onFileChanged: (vpath) => this.debouncedLocalChange(vpath),

      onFileAdded: async (vpath) => {
        // New local file -> create in Relay
        if (!this.connections.has(vpath)) {
          logger.info(`Local file added: ${vpath}`);
          await this.createRemoteDocument(vpath);
        }
      },

      onFileDeleted: async (vpath) => {
        logger.info(`Local file deleted: ${vpath}`);
        await this.deleteRemoteDocument(vpath);
      },
    },
    (vpath) => this.suppressedPaths.has(vpath),
  );
  this.fileWatcher.start();
}

private debouncedLocalChange(vpath: string): void {
  const existing = this.localChangeTimers.get(vpath);
  if (existing) clearTimeout(existing);

  this.localChangeTimers.set(vpath, setTimeout(async () => {
    this.localChangeTimers.delete(vpath);
    try {
      const conn = this.connections.get(vpath);
      if (!conn) return;
      const diskContent = await this.diskManager.readDocument(vpath);
      applyTextToYDoc(conn.ydoc, diskContent);
      logger.debug(`Pushed local changes to remote: ${vpath}`);
    } catch (err) {
      logger.error(`Failed to push local changes for ${vpath}:`, err);
    }
  }, this.config.debounceMs));
}

async createRemoteDocument(vpath: string): Promise<void> {
  // 1. Generate a new UUID for the document
  const docId = crypto.randomUUID();

  // 2. Add entry to folder's filemeta_v0
  const meta: DocumentMeta = {
    version: 0,
    id: docId,
    type: SyncType.Document,
  };
  this.folderSync.filemeta.set(vpath, meta);

  // 3. Connect to the new document's Y.Doc and set initial content
  const docSync = new DocumentSync(vpath, meta, this.config, this.tokenStore);
  await docSync.connect();

  const diskContent = await this.diskManager.readDocument(vpath);
  applyTextToYDoc(docSync.ydoc, diskContent);

  this.connections.set(vpath, docSync);
  docSync.observeRemoteChanges((p, c) => this.onRemoteDocChange(p, c));
}

async deleteRemoteDocument(vpath: string): Promise<void> {
  const conn = this.connections.get(vpath);
  if (conn) {
    conn.disconnect();
    this.connections.delete(vpath);
  }
  // Remove from folder metadata
  this.folderSync.filemeta.delete(vpath);
}
```

### 4.4 Rename Detection

Chokidar doesn't have a native rename event. Detect renames by correlating `unlink` + `add` events within a short window:

```typescript
// In SyncCoordinator.ts

private pendingDeletes = new Map<string, { meta: Meta; timer: Timer }>();
private readonly RENAME_WINDOW_MS = 500;

handlePossibleRename(deletedVpath: string, meta: Meta): void {
  // Store the delete, wait for a matching add
  this.pendingDeletes.set(deletedVpath, {
    meta,
    timer: setTimeout(() => {
      // No matching add -- it's a real delete
      this.pendingDeletes.delete(deletedVpath);
      this.deleteRemoteDocument(deletedVpath);
    }, this.RENAME_WINDOW_MS),
  });
}

handlePossibleRenameTarget(addedVpath: string): Meta | null {
  // Check if any pending delete has the same content hash or size
  // For text files, we can compare content
  for (const [oldVpath, pending] of this.pendingDeletes) {
    clearTimeout(pending.timer);
    this.pendingDeletes.delete(oldVpath);

    // Update filemeta: delete old path, add new path with same docId
    this.folderSync.filemeta.delete(oldVpath);
    this.folderSync.filemeta.set(addedVpath, pending.meta);

    // Update internal connection map
    const conn = this.connections.get(oldVpath);
    if (conn) {
      conn.vpath = addedVpath;
      this.connections.delete(oldVpath);
      this.connections.set(addedVpath, conn);
    }

    return pending.meta;
  }
  return null;
}
```

---

## Phase 5: Binary File Support

### 5.1 Binary Sync (`sync/BinarySync.ts`)

Binary files (images, PDFs, audio, video) use content-addressed storage, not Y.Docs. The flow is:

1. Get a `FileToken` via `POST /file-token` with the file's S3RN, hash, content type, and size
2. Use the `FileToken` to get presigned upload/download URLs
3. Upload/download the actual file bytes to/from S3

```typescript
class BinarySync {
  constructor(
    private config: Config,
    private authManager: AuthManager,
  ) {}

  async downloadFile(vpath: string, meta: FileMetas): Promise<ArrayBuffer> {
    // 1. Build the S3RN for this file
    const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:file:${meta.id}`;

    // 2. Get file token
    const fileToken = await this.getFileToken(s3rn, meta.hash, meta.mimetype, 0);

    // 3. Get presigned download URL
    const response = await fetch(fileToken.baseUrl + "/download-url", {
      headers: { Authorization: `Bearer ${fileToken.token}` },
    });
    const { downloadUrl } = await response.json();

    // 4. Download the file
    const downloadResponse = await fetch(downloadUrl);
    return downloadResponse.arrayBuffer();
  }

  async uploadFile(vpath: string, meta: FileMetas, content: ArrayBuffer): Promise<string> {
    const hash = await this.computeSHA256(content);

    // Skip upload if hash matches (file unchanged)
    if (meta.hash === hash) return hash;

    const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:file:${meta.id}`;

    // 1. Get file token
    const fileToken = await this.getFileToken(s3rn, hash, meta.mimetype, content.byteLength);

    // 2. Get presigned upload URL
    const response = await fetch(fileToken.baseUrl + "/upload-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${fileToken.token}` },
    });
    const { uploadUrl } = await response.json();

    // 3. Upload the file
    await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": meta.mimetype },
      body: content,
    });

    return hash;
  }

  private async getFileToken(
    s3rn: string, hash: string, contentType: string, contentLength: number,
  ): Promise<FileToken> {
    const entity = S3RN.decode(s3rn);
    if (!(entity instanceof S3RemoteFile)) {
      throw new Error(`Invalid S3RN for file: ${s3rn}`);
    }

    const response = await fetch(`${this.config.apiUrl}/file-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authManager.getToken()}`,
        "Content-Type": "application/json",
        "Relay-Version": RELAY_VERSION,
      },
      body: JSON.stringify({
        docId: entity.fileId,
        relay: entity.relayId,
        folder: entity.folderId,
        hash,
        contentType,
        contentLength,
      }),
    });

    if (!response.ok) {
      throw new Error(`File token fetch failed: ${response.status}`);
    }

    return response.json() as Promise<FileToken>;
  }

  async computeSHA256(content: ArrayBuffer): Promise<string> {
    // Bun's native crypto
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new Uint8Array(content));
    return hasher.digest("hex");
  }
}
```

### 5.2 Binary File Integration in SyncCoordinator

```typescript
// Extend initialSync to handle binary files
async initialSync(): Promise<void> {
  // ... existing document sync ...

  // Download binary files
  const binaryFiles = [...files.entries()]
    .filter(([, meta]) => isBinaryType(meta.type));

  for (const [vpath, meta] of binaryFiles) {
    try {
      const content = await this.binarySync.downloadFile(vpath, meta as FileMetas);
      await this.diskManager.writeBinary(vpath, content);
      logger.info(`Downloaded binary: ${vpath} (${content.byteLength} bytes)`);
    } catch (err) {
      logger.error(`Failed to download binary ${vpath}:`, err);
    }
  }
}

// Handle local binary file changes
async onLocalBinaryChanged(vpath: string): Promise<void> {
  const meta = this.folderSync.filemeta.get(vpath) as FileMetas;
  if (!meta) return;

  const content = await this.diskManager.readBinary(vpath);
  const newHash = await this.binarySync.computeSHA256(content);

  if (newHash === meta.hash) return; // No change

  await this.binarySync.uploadFile(vpath, meta, content);

  // Update filemeta with new hash and synctime
  this.folderSync.filemeta.set(vpath, {
    ...meta,
    hash: newHash,
    synctime: Date.now(),
  });
  logger.info(`Uploaded binary: ${vpath}`);
}

// Handle remote binary metadata changes (hash changed = new version available)
async onRemoteBinaryChanged(vpath: string, meta: FileMetas): Promise<void> {
  // Check if local hash matches
  try {
    const localContent = await this.diskManager.readBinary(vpath);
    const localHash = await this.binarySync.computeSHA256(localContent);
    if (localHash === meta.hash) return; // Already up to date
  } catch { /* File doesn't exist locally yet */ }

  const content = await this.binarySync.downloadFile(vpath, meta);
  this.suppressedPaths.add(vpath);
  await this.diskManager.writeBinary(vpath, content);
  setTimeout(() => this.suppressedPaths.delete(vpath), 500);
  logger.info(`Updated binary from remote: ${vpath}`);
}
```

### 5.3 SyncType Helpers

```typescript
// In protocol/types.ts

/** Must be sent as "Relay-Version" header on all /token and /file-token API requests. */
const RELAY_VERSION = "0.7.4";

enum SyncType {
  Folder = "folder",
  Document = "markdown",
  Canvas = "canvas",
  Image = "image",
  PDF = "pdf",
  Audio = "audio",
  Video = "video",
  File = "file",
}

function isBinaryType(type: SyncType): boolean {
  return [SyncType.Image, SyncType.PDF, SyncType.Audio, SyncType.Video, SyncType.File].includes(type);
}

function isTextType(type: SyncType): boolean {
  return type === SyncType.Document || type === SyncType.Canvas;
}

function getMimeTypeForExtension(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
    pdf: "application/pdf",
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac",
    ogg: "audio/ogg", m4a: "audio/x-m4a",
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    canvas: "application/canvas+json",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

function getSyncTypeForMimetype(mimetype: string): SyncType {
  if (mimetype === "text/markdown") return SyncType.Document;
  if (mimetype === "application/canvas+json") return SyncType.Canvas;
  if (mimetype.startsWith("image/")) return SyncType.Image;
  if (mimetype === "application/pdf") return SyncType.PDF;
  if (mimetype.startsWith("audio/")) return SyncType.Audio;
  if (mimetype.startsWith("video/")) return SyncType.Video;
  return SyncType.File;
}
```

---

## Configuration

### `.env.example`

```env
# Required
RELAY_GUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
FOLDER_GUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
SYNC_DIR=/data/relay-sync

# Auth (provide one)
RELAY_TOKEN=eyJhbGciOiJIUzI1NiIs...

# Optional
API_URL=https://api.system3.md
AUTH_URL=https://auth.system3.md
DEBOUNCE_MS=2000
PERSISTENCE_DIR=/data/relay-sync/.relay-sync
LOG_LEVEL=info
```

### `package.json`

```json
{
  "name": "relay-sync-daemon",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts",
    "auth": "bun run src/index.ts auth",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "yjs": "^13.6.0",
    "y-protocols": "^1.0.6",
    "lib0": "^0.2.88",
    "pocketbase": "^0.26.0",
    "chokidar": "^4.0.0",
    "diff-match-patch": "^1.0.5",
    "jose": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/diff-match-patch": "^1.0.36",
    "bun-types": "latest"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

---

## Entry Point (`src/index.ts`)

```typescript
import { loadConfig } from "./config";
import { AuthManager } from "./auth/AuthManager";
import { TokenStore } from "./auth/TokenStore";
import { SyncCoordinator } from "./sync/SyncCoordinator";
import { logger } from "./util/logger";

async function main() {
  const args = process.argv.slice(2);

  // Handle "auth" subcommand for interactive OAuth2 login
  if (args[0] === "auth") {
    const config = loadConfig({ requireToken: false });
    const auth = new AuthManager(config.authUrl);
    await auth.cliOAuth2Flow();
    process.exit(0);
  }

  const config = loadConfig();
  logger.info("Starting Relay Sync Daemon");
  logger.info(`Relay: ${config.relayGuid}`);
  logger.info(`Folder: ${config.folderGuid}`);
  logger.info(`Sync dir: ${config.syncDir}`);

  // 1. Authenticate (tries persisted .relay-auth first, then RELAY_TOKEN env var)
  const auth = new AuthManager(config.authUrl, config.persistenceDir ?? join(config.syncDir, ".relay-sync"));
  await auth.initialize(config.relayToken);

  // 2. Create token store
  const tokenStore = new TokenStore(auth, config.apiUrl);

  // 3. Start sync coordinator
  const coordinator = new SyncCoordinator(config, auth, tokenStore);

  // 4. Initial sync (Phase 2)
  await coordinator.initialSync();

  // 5. Start watching (Phase 3 + 4)
  coordinator.setupRemoteWatching();
  coordinator.setupLocalWatching();
  coordinator.startTokenRefreshLoop();

  // 6. Handle graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await coordinator.shutdown();
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
```

---

## Error Handling & Resilience

### Connection Loss

- **WebSocket disconnect**: YSweetProvider has built-in exponential backoff reconnection (100ms, 200ms, 400ms... up to `maxBackoffTime`). Caps at 3 failed reconnects by default, then stops. The daemon should request a fresh token and create a new provider if the old one exhausts retries.
- **Token expiry during disconnect**: The token refresh loop handles this. On reconnect, a fresh ClientToken is obtained.

### Conflict Resolution

- **Concurrent edits**: Yjs CRDTs handle this automatically. Two users editing the same document at different positions will merge cleanly. Same-position edits are resolved deterministically by Yjs (last writer wins at the character level, but structure is preserved).
- **Local edit during remote push**: The `"local-edit"` transaction origin prevents echo loops. Remote changes are debounced before writing to disk, and the suppression set prevents the file watcher from re-reading files we just wrote.

### Crash Recovery

- **Y.Doc state**: Persisted to disk periodically (every 30s) and on shutdown. On restart, state is loaded before connecting, so only the delta since last save needs to be synced.
- **Interrupted writes**: Atomic writes (write to `.tmp` then rename) prevent partial file corruption.
- **Orphaned temp files**: On startup, clean up any `.tmp` files in SYNC_DIR.

### Rate Limiting

- **Token requests**: Deduplicated via `activeRequests` map. Max 5 concurrent WebSocket connections.
- **File writes**: Debounced (default 2s) to batch rapid changes.
- **Binary uploads**: SHA256 comparison avoids redundant uploads.

### Graceful Shutdown

```typescript
async shutdown(): Promise<void> {
  // 1. Stop file watcher
  await this.fileWatcher.stop();

  // 2. Flush pending debounced writes
  for (const [vpath, timer] of this.localChangeTimers) {
    clearTimeout(timer);
    // Do one final sync
    const conn = this.connections.get(vpath);
    if (conn) {
      const diskContent = await this.diskManager.readDocument(vpath);
      applyTextToYDoc(conn.ydoc, diskContent);
    }
  }

  // 3. Persist all Y.Doc states
  for (const [vpath, conn] of this.connections) {
    await this.docStore.save(conn.meta.id, conn.ydoc);
  }
  await this.docStore.save(this.config.folderGuid, this.folderSync.ydoc);

  // 4. Disconnect all providers
  for (const conn of this.connections.values()) {
    conn.disconnect();
  }
  this.folderSync.disconnect();

  // 5. Stop token refresh
  clearInterval(this.refreshInterval);
}
```

---

## Risks & Open Questions

### Risks

1. **Concurrent token limits**: The API may have per-user connection limits. With many documents, we may need to lazily connect/disconnect documents rather than keeping all connections open simultaneously. Consider a connection pool with LRU eviction.

2. **Memory with many docs**: Each Y.Doc holds its full CRDT history in memory. For folders with hundreds of documents, memory usage could grow significantly. Mitigation: use persistence + lazy loading (only connect documents that have changed recently).

3. **Race conditions on startup**: If the daemon starts while another client is actively editing, the initial download could interleave with remote changes. The Yjs sync protocol handles this correctly, but the disk write timing needs care.

4. **Atomic rename detection**: The unlink+add heuristic for rename detection is imperfect. If a user deletes a file and creates a new one with different content within the rename window, it could be misidentified as a rename.

5. **Canvas files**: Canvas files (`SyncType.Canvas`) use Y.Doc like documents but contain JSON, not markdown. The daemon should handle these similarly to documents but using a `.canvas` extension. Canvas content is stored in `Y.Text("contents")` just like markdown docs, but the text is JSON with an `{edges:[], nodes:[]}` structure. The sync mechanism is identical; only the file extension and S3RN type segment (`canvas:` instead of `doc:`) differ.

6. **Large file handling**: Binary files could be very large (videos). Downloads/uploads should ideally use streaming, not loading entirely into memory. Bun's `Bun.write()` and fetch streaming can help.

### Open Questions

1. **Should the daemon create new Y.Docs for locally created files, or does the server auto-create them?** Based on the plugin code, the client creates the Y.Doc and the server persists it on first sync. The daemon needs to handle the POST /token call for a docId that doesn't yet exist server-side. Verify this works.

2. **How does the server handle Y.Doc creation for brand-new document IDs?** The y-sweet server likely auto-creates storage on first connection. Need to confirm.

3. **Token refresh race condition**: If a WebSocket is mid-sync when the token expires, does the server drop the connection immediately or allow the current message to complete? The refresh loop aims to refresh well before expiry (10 min buffer).

4. **Should subdirectories in filemeta_v0 paths map 1:1 to filesystem directories?** **Resolved.** Yes, paths in `filemeta_v0` are relative paths with forward slashes (e.g., `subfolder/doc.md`) and map 1:1 to filesystem directories. The daemon should create subdirectories as needed and use these paths directly.

5. **Conflict policy for binary files**: If a binary file is modified both locally and remotely between sync cycles, which version wins? Currently the plan uses hash comparison -- if hashes differ, the remote version is downloaded (remote wins). This should be configurable or at least documented.

6. **PocketBase auth store persistence**: **Resolved.** The daemon persists the PocketBase auth token to a `.relay-auth` file in the persistence directory. On startup, it checks for this file first, then falls back to the `RELAY_TOKEN` env var. After each successful token refresh, the new token is written to `.relay-auth`. This means a one-time `RELAY_TOKEN` bootstrap leads to self-sustaining auth across restarts. See the `AuthManager` code sketch above for the implementation.

7. **Awareness protocol**: **Resolved.** The daemon sets awareness state on all connections identifying itself as a bot client: `{ user: { name: "relay-sync-daemon", color: "#888888", isBot: true } }`. This lets other connected users see that the sync daemon is online. See the `FolderSync` and `DocumentSync` code sketches above.

8. **filemeta_v0 path encoding**: **Resolved.** Paths are raw (not URL-encoded), using forward slashes. The plugin's `normalizePath` simply normalizes slash direction and removes trailing slashes -- no encoding/decoding is needed.

9. **Canvas support scope**: **Resolved.** Canvas files are included in Phase 2 since the sync mechanism is identical (Y.Doc with Y.Text containing the content). The only differences: the content is JSON rather than markdown, and files use a `.canvas` extension. The `isTextType()` helper already returns `true` for `SyncType.Canvas`, so no special handling is needed beyond using the correct file extension.
