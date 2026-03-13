# Task 6: Error Handling & Resilience

## Connection Loss Recovery
- [x] Handle WebSocket disconnect — YSweetProvider exponential backoff (100ms → maxBackoffTime)
- [x] Detect when provider exhausts retries (3 failed reconnects)
- [x] On exhausted retries: request fresh ClientToken, create new YSweetProvider, re-establish sync
- [x] Handle token expiry during disconnect — token refresh loop handles this automatically
- [ ] Test: simulate network disconnect, verify reconnection and sync resumes

## Graceful Shutdown
- [x] Implement `shutdown()` in SyncCoordinator
- [x] Stop file watcher first
- [x] Flush all pending debounced writes (clear timers, do final sync for each)
- [x] Persist all Y.Doc states to disk
- [x] Disconnect all providers (documents + folder)
- [x] Stop token refresh interval
- [x] Wire shutdown to SIGINT and SIGTERM in index.ts
- [ ] Test: Ctrl+C during active sync, verify clean shutdown and no data loss

## Crash Recovery
- [x] On startup: clean up orphaned `.tmp` files in SYNC_DIR
- [x] On startup: load persisted Y.Doc states before connecting (delta sync)
- [x] Verify atomic writes prevent partial file corruption on crash
- [ ] Test: kill daemon mid-write, verify no corrupted files on restart

## Rate Limiting & Resource Management
- [x] Deduplicate concurrent token requests via `activeRequests` map in TokenStore
- [x] Limit concurrent WebSocket connections (batch size of 5 in initial sync)
- [x] Debounce file writes (configurable DEBOUNCE_MS, default 2000)
- [x] Skip redundant binary uploads via SHA256 comparison
- [ ] Consider connection pool with LRU eviction for large folders (future)

## Logging & Observability
- [x] Structured logging with levels: debug, info, warn, error
- [x] Log all connection events (connect, disconnect, reconnect, token refresh)
- [x] Log all sync events (file added, changed, deleted, renamed)
- [x] Log errors with context (vpath, S3RN, error message)
- [x] Configurable LOG_LEVEL via env var
