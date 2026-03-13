# Task 6: Error Handling & Resilience

## Connection Loss Recovery
- [ ] Handle WebSocket disconnect — YSweetProvider exponential backoff (100ms → maxBackoffTime)
- [ ] Detect when provider exhausts retries (3 failed reconnects)
- [ ] On exhausted retries: request fresh ClientToken, create new YSweetProvider, re-establish sync
- [ ] Handle token expiry during disconnect — token refresh loop handles this automatically
- [ ] Test: simulate network disconnect, verify reconnection and sync resumes

## Graceful Shutdown
- [ ] Implement `shutdown()` in SyncCoordinator
- [ ] Stop file watcher first
- [ ] Flush all pending debounced writes (clear timers, do final sync for each)
- [ ] Persist all Y.Doc states to disk
- [ ] Disconnect all providers (documents + folder)
- [ ] Stop token refresh interval
- [ ] Wire shutdown to SIGINT and SIGTERM in index.ts
- [ ] Test: Ctrl+C during active sync, verify clean shutdown and no data loss

## Crash Recovery
- [ ] On startup: clean up orphaned `.tmp` files in SYNC_DIR
- [ ] On startup: load persisted Y.Doc states before connecting (delta sync)
- [ ] Verify atomic writes prevent partial file corruption on crash
- [ ] Test: kill daemon mid-write, verify no corrupted files on restart

## Rate Limiting & Resource Management
- [ ] Deduplicate concurrent token requests via `activeRequests` map in TokenStore
- [ ] Limit concurrent WebSocket connections (batch size of 5 in initial sync)
- [ ] Debounce file writes (configurable DEBOUNCE_MS, default 2000)
- [ ] Skip redundant binary uploads via SHA256 comparison
- [ ] Consider connection pool with LRU eviction for large folders (future)

## Logging & Observability
- [ ] Structured logging with levels: debug, info, warn, error
- [ ] Log all connection events (connect, disconnect, reconnect, token refresh)
- [ ] Log all sync events (file added, changed, deleted, renamed)
- [ ] Log errors with context (vpath, S3RN, error message)
- [ ] Configurable LOG_LEVEL via env var
