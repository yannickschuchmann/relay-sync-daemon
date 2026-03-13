# Task 2: Download Documents (Phase 2)

## DocumentSync (`src/sync/DocumentSync.ts`)
- [x] Create Y.Doc and get `Y.Text("contents")`
- [x] Implement `connect()` — build S3RN (use "canvas:" vs "doc:" based on SyncType), get ClientToken, create YSweetProvider, set awareness, wait for sync
- [x] Implement `getContent()` — return ytext.toString()
- [x] Implement `disconnect()` — destroy provider
- [ ] Test: connect to a known document, verify content matches Obsidian

## DiskManager (`src/fs/DiskManager.ts`)
- [x] Implement `writeDocument()` — atomic write via .tmp + rename, create parent dirs
- [x] Implement `readDocument()` — read utf-8 text
- [x] Implement `deleteDocument()` — unlink, ignore if already deleted
- [x] Implement `writeBinary()` — atomic write for binary content
- [x] Implement `readBinary()` — read as ArrayBuffer
- [x] Implement `toAbsolute()` / `toVpath()` path conversion helpers
- [ ] Test: write and read back a document, verify content roundtrips

## DocStore / CRDT Persistence (`src/persistence/DocStore.ts`)
- [x] Implement `save()` — encode Y.Doc state as update, write to `{docId}.ystate`
- [x] Implement `load()` — read .ystate file, apply update to Y.Doc
- [x] Implement periodic save (every 30s) in SyncCoordinator
- [x] Implement save-on-shutdown in SyncCoordinator
- [ ] Test: save state, create new Y.Doc, load state, verify content matches
- [ ] Test: restart daemon, verify incremental sync (not full re-download)

## Initial Sync Orchestration (`src/sync/SyncCoordinator.ts`)
- [x] Implement `initialSync()` — connect folder, list files, filter text types
- [x] Batch document connections (5 at a time) to avoid overwhelming server
- [x] For each document: connect, get content, write to disk, store connection
- [x] Handle canvas files (same sync mechanism, `.canvas` extension)
- [x] Log progress: file count, per-file char count
- [x] Clean up orphaned `.tmp` files on startup
- [ ] Test: run initial sync against real folder, verify all documents written to SYNC_DIR
- [ ] Test: verify canvas files are synced with correct extension
