# Task 4: Watch Local Changes & Push to Relay (Phase 4)

## FileWatcher (`src/fs/FileWatcher.ts`)
- [x] Implement chokidar watcher with correct ignore patterns (dotfiles, .tmp, .ystate, node_modules)
- [x] Configure `ignoreInitial: true` (don't fire for existing files on startup)
- [x] Configure `awaitWriteFinish` (stabilityThreshold: 1000ms, pollInterval: 100ms)
- [x] Configure `atomic: true` for atomic save detection
- [x] Wire up "change", "add", "unlink" events with vpath conversion
- [x] Check suppression set before emitting events
- [x] Implement `start()` and `stop()` lifecycle methods
- [ ] Test: create/modify/delete files in SYNC_DIR, verify events fire correctly
- [ ] Test: verify .tmp and dotfiles are ignored

## TextDiff (`src/diff/TextDiff.ts`)
- [x] Port `y-diffMatchPatch.ts` from existing Relay plugin
- [x] Implement `applyTextToYDoc()` — compute diffs with diff-match-patch, apply as Y.Text insert/delete ops
- [x] Use `"local-edit"` as transaction origin to prevent echo loops
- [x] Skip if content is identical (no-op optimization)
- [x] Apply `diff_cleanupSemantic()` for cleaner diffs
- [ ] Test: apply known text changes, verify Y.Text matches expected content
- [ ] Test: verify empty diff produces no Y.Doc transaction

## Local Change Handling in SyncCoordinator
- [x] Implement `setupLocalWatching()` — create FileWatcher with handlers
- [x] Implement `debouncedLocalChange()` — debounce per-file with configurable DEBOUNCE_MS
- [x] On file changed: read disk content, call `applyTextToYDoc()` on connection's Y.Doc
- [x] On file added (new local file): call `createRemoteDocument()`
- [x] On file deleted: call `deleteRemoteDocument()`
- [x] Implement `createRemoteDocument()` — generate UUID, add to filemeta_v0, connect DocumentSync, set initial content
- [x] Implement `deleteRemoteDocument()` — disconnect, remove from filemeta_v0
- [ ] Test: edit a local file, verify change appears in Relay/Obsidian
- [ ] Test: create a new local file, verify it appears in Obsidian
- [ ] Test: delete a local file, verify it's removed from Obsidian

## Rename Detection
- [x] Implement `handlePossibleRename()` — buffer deletes with 500ms rename window
- [x] Implement `handlePossibleRenameTarget()` — correlate add with pending delete
- [x] On rename detected: update filemeta_v0 (delete old path, set new path with same docId), update connections map
- [x] On rename timeout: treat as real delete
- [ ] Test: rename a file, verify filemeta_v0 updated correctly (same docId, new path)
- [ ] Test: verify actual delete (no matching add) still works after rename window
