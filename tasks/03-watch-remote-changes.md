# Task 3: Watch Remote Changes (Phase 3)

## Document Text Observation
- [x] ✅ Implement `observeRemoteChanges()` in DocumentSync — observe Y.Text changes
- [x] ✅ Skip changes with `"local-edit"` transaction origin (avoid echo loops)
- [x] ✅ Debounce rapid remote edits before writing to disk
- [x] ✅ Call `onRemoteDocChange()` callback with vpath and new content

## Folder Metadata Observation
- [x] ✅ Implement `observeMetaChanges()` in FolderSync — observe filemeta_v0 Y.Map
- [x] ✅ Handle "add" events — new file appeared in shared folder
- [x] ✅ Handle "delete" events — file removed from shared folder
- [x] ✅ Handle "update" events — metadata changed (hash update for binaries, etc.)
- [x] ✅ Emit structured callbacks: onFileAdded, onFileDeleted, onFileUpdated

## SyncCoordinator Remote Handling
- [x] ✅ Implement `setupRemoteWatching()` — wire up folder meta observation
- [x] ✅ On file added: create DocumentSync, connect, download content, write to disk, start observing
- [x] ✅ On file deleted: disconnect DocumentSync, delete local file, remove from connections map
- [x] ✅ On file updated: handle metadata changes (binary hash changes deferred to Phase 5)
- [x] ✅ Implement `onRemoteDocChange()` — write content to disk with suppression
- [x] ✅ Implement suppression set (`suppressedPaths`) — prevent file watcher from re-reading files we just wrote
- [x] ✅ Set suppression timeout (500ms) to clear after watcher event passes
- [ ] Test: edit a document in Obsidian, verify daemon writes updated content to disk
- [ ] Test: create a new document in Obsidian, verify daemon creates file locally
- [ ] Test: delete a document in Obsidian, verify daemon removes local file
- [ ] Test: verify no echo loop (remote change → disk write → watcher → no re-push)
