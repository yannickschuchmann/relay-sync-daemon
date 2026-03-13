# Task 2: Download Documents (Phase 2)

## DocumentSync (`src/sync/DocumentSync.ts`)
- [ ] Create Y.Doc and get `Y.Text("contents")`
- [ ] Implement `connect()` — build S3RN (use "canvas:" vs "doc:" based on SyncType), get ClientToken, create YSweetProvider, set awareness, wait for sync
- [ ] Implement `getContent()` — return ytext.toString()
- [ ] Implement `disconnect()` — destroy provider
- [ ] Test: connect to a known document, verify content matches Obsidian

## DiskManager (`src/fs/DiskManager.ts`)
- [ ] Implement `writeDocument()` — atomic write via .tmp + rename, create parent dirs
- [ ] Implement `readDocument()` — read utf-8 text
- [ ] Implement `deleteDocument()` — unlink, ignore if already deleted
- [ ] Implement `writeBinary()` — atomic write for binary content
- [ ] Implement `readBinary()` — read as ArrayBuffer
- [ ] Implement `toAbsolute()` / `toVpath()` path conversion helpers
- [ ] Test: write and read back a document, verify content roundtrips

## DocStore / CRDT Persistence (`src/persistence/DocStore.ts`)
- [ ] Implement `save()` — encode Y.Doc state as update, write to `{docId}.ystate`
- [ ] Implement `load()` — read .ystate file, apply update to Y.Doc
- [ ] Implement periodic save (every 30s) in SyncCoordinator
- [ ] Implement save-on-shutdown in SyncCoordinator
- [ ] Test: save state, create new Y.Doc, load state, verify content matches
- [ ] Test: restart daemon, verify incremental sync (not full re-download)

## Initial Sync Orchestration (`src/sync/SyncCoordinator.ts`)
- [ ] Implement `initialSync()` — connect folder, list files, filter text types
- [ ] Batch document connections (5 at a time) to avoid overwhelming server
- [ ] For each document: connect, get content, write to disk, store connection
- [ ] Handle canvas files (same sync mechanism, `.canvas` extension)
- [ ] Log progress: file count, per-file char count
- [ ] Clean up orphaned `.tmp` files on startup
- [ ] Test: run initial sync against real folder, verify all documents written to SYNC_DIR
- [ ] Test: verify canvas files are synced with correct extension
