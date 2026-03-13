# Task 1: Auth + Folder Connection (Phase 1)

## AuthManager (`src/auth/AuthManager.ts`)
- [x] Implement PocketBase client initialization
- [x] Implement `loadPersistedToken()` — read `.relay-auth` file from persistence dir
- [x] Implement `persistToken()` — write token to `.relay-auth` file
- [x] Implement `bootstrapFromToken()` — set auth store, validate, call authRefresh(), persist
- [x] Implement `initialize()` — try persisted token first, then RELAY_TOKEN env var fallback
- [x] Implement `scheduleRefresh()` — refresh token every 12 hours via setInterval
- [x] Implement `getToken()` accessor
- [x] Test: bootstrap with a real PocketBase JWT, verify authRefresh works
- [x] Test: restart daemon, verify it loads from `.relay-auth` without needing RELAY_TOKEN

## TokenStore (`src/auth/TokenStore.ts`)
- [x] Implement ClientToken cache (Map keyed by S3RN)
- [x] Implement `fetchToken()` — POST to `/token` endpoint with auth header + Relay-Version
- [x] Implement `getToken()` — check cache validity (5 min buffer), deduplicate concurrent requests
- [x] Implement `isValid()` — check expiry with 5 minute buffer
- [x] Implement `getCached()` — expose cached tokens for refresh loop inspection
- [x] Test: verify token caching prevents duplicate API calls
- [x] Test: verify expired tokens trigger re-fetch

## YSweetProvider (`src/protocol/YSweetProvider.ts`)
- [x] Port provider from existing plugin (`/context/Relay/src/client/provider.ts`)
- [x] Remove browser-specific code (window.addEventListener, BroadcastChannel)
- [x] Remove Obsidian-specific imports
- [x] Use Bun's native WebSocket (standard API)
- [x] Keep y-protocols sync message handling (SyncStep1, SyncStep2, Update)
- [x] Keep awareness protocol handling
- [x] Keep auth message handling
- [x] Keep exponential backoff reconnection logic
- [x] Add `refreshToken(url, docId, token)` method for token rotation
- [x] Implement `messages.ts` — message type constants and handler registration

## FolderSync (`src/sync/FolderSync.ts`)
- [x] Create Y.Doc and get `filemeta_v0` Y.Map
- [x] Implement `connect()` — build S3RN, get ClientToken, create YSweetProvider, set awareness, wait for sync
- [x] Implement `listFiles()` — iterate filemeta_v0 and return Map<string, Meta>
- [x] Implement `disconnect()`
- [x] Test: connect to real folder, log file count from filemeta_v0

## Token Refresh Loop
- [x] Implement `startTokenRefreshLoop()` in SyncCoordinator — check every 5 min for tokens expiring within 10 min
- [x] Call `provider.refreshToken()` with fresh ClientToken when needed
- [x] Test: verify connections survive past token expiry window
