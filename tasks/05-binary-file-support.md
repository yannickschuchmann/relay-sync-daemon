# Task 5: Binary File Support (Phase 5)

## BinarySync (`src/sync/BinarySync.ts`)
- [ ] Implement `getFileToken()` — POST to `/file-token` with S3RN, hash, contentType, contentLength
- [ ] Implement `downloadFile()` — get file token, fetch presigned download URL, download bytes
- [ ] Implement `uploadFile()` — compute hash, skip if unchanged, get file token, fetch presigned upload URL, PUT bytes
- [ ] Implement `computeSHA256()` — use Bun.CryptoHasher
- [ ] Test: download a known binary file (image), verify hash matches
- [ ] Test: upload a binary file, verify it appears in Relay

## Initial Sync Extension
- [ ] Extend `initialSync()` to handle binary files after documents
- [ ] Filter files by `isBinaryType()` from filemeta_v0
- [ ] Download each binary file and write to disk via DiskManager
- [ ] Log per-file byte count
- [ ] Test: verify images/PDFs from shared folder are downloaded correctly

## Remote Binary Change Handling
- [ ] Implement `onRemoteBinaryChanged()` in SyncCoordinator
- [ ] Compare local hash with remote meta hash
- [ ] Download new version if hashes differ (remote wins)
- [ ] Use suppression set to prevent watcher echo
- [ ] Wire into `onFileUpdated` handler in `setupRemoteWatching()`
- [ ] Test: update an image in Obsidian, verify daemon downloads new version

## Local Binary Change Handling
- [ ] Implement `onLocalBinaryChanged()` in SyncCoordinator
- [ ] Compute SHA256 of local file, compare with filemeta hash
- [ ] Upload if changed, update filemeta_v0 with new hash and synctime
- [ ] Wire into FileWatcher handlers (distinguish text vs binary by extension/mimetype)
- [ ] Test: replace a local image, verify it uploads to Relay
- [ ] Test: verify unchanged binary files are skipped (hash match)
