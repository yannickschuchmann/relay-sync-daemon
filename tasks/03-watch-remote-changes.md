# Task 3: Watch Remote Changes (Phase 3)

## Document Text Observation
- [ ] Implement `observeRemoteChanges()` in DocumentSync — observe Y.Text changes
- [ ] Skip changes with `"local-edit"` transaction origin (avoid echo loops)
- [ ] Debounce rapid remote edits before writing to disk
- [ ] Call `onRemoteDocChange()` callback with vpath and new content

## Folder Metadata Observation
- [ ] Implement `observeMetaChanges()` in FolderSync — observe filemeta_v0 Y.Map
- [ ] Handle "add" events — new file appeared in shared folder
- [ ] Handle "delete" events — file removed from shared folder
- [ ] Handle "update" events — metadata changed (hash update for binaries, etc.)
- [ ] Emit structured callbacks: onFileAdded, onFileDeleted, onFileUpdated

## SyncCoordinator Remote Handling
- [ ] Implement `setupRemoteWatching()` — wire up folder meta observation
- [ ] On file added: create DocumentSync, connect, download content, write to disk, start observing
- [ ] On file deleted: disconnect DocumentSync, delete local file, remove from connections map
- [ ] On file updated: handle metadata changes (binary hash changes deferred to Phase 5)
- [ ] Implement `onRemoteDocChange()` — write content to disk with suppression
- [ ] Implement suppression set (`suppressedPaths`) — prevent file watcher from re-reading files we just wrote
- [ ] Set suppression timeout (500ms) to clear after watcher event passes
- [ ] Test: edit a document in Obsidian, verify daemon writes updated content to disk
- [ ] Test: create a new document in Obsidian, verify daemon creates file locally
- [ ] Test: delete a document in Obsidian, verify daemon removes local file
- [ ] Test: verify no echo loop (remote change → disk write → watcher → no re-push)
