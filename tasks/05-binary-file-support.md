# Task 5: Binary File Support (Phase 5)

## BinarySync (`src/sync/BinarySync.ts`)
- [x] Implement `getFileToken()` — POST to `/file-token` with S3RN, hash, contentType, contentLength
- [x] Implement `downloadFile()` — get file token, fetch presigned download URL, download bytes
- [x] Implement `uploadFile()` — compute hash, skip if unchanged, get file token, fetch presigned upload URL, PUT bytes
- [x] Implement `computeSHA256()` — use Bun.CryptoHasher
- [x] Test: download a known binary file (image), verify hash matches
- [x] Test: upload a binary file, verify it appears in Relay

## Initial Sync Extension
- [x] Extend `initialSync()` to handle binary files after documents
- [x] Filter files by `isBinaryType()` from filemeta_v0
- [x] Download each binary file and write to disk via DiskManager
- [x] Log per-file byte count
- [x] Test: verify images/PDFs from shared folder are downloaded correctly

## Remote Binary Change Handling
- [x] Implement `onRemoteBinaryChanged()` in SyncCoordinator
- [x] Compare local hash with remote meta hash
- [x] Download new version if hashes differ (remote wins)
- [x] Use suppression set to prevent watcher echo
- [x] Wire into `onFileUpdated` handler in `setupRemoteWatching()`
- [x] Test: update an image in Obsidian, verify daemon downloads new version

## Local Binary Change Handling
- [x] Implement `onLocalBinaryChanged()` in SyncCoordinator
- [x] Compute SHA256 of local file, compare with filemeta hash
- [x] Upload if changed, update filemeta_v0 with new hash and synctime
- [x] Wire into FileWatcher handlers (distinguish text vs binary by extension/mimetype)
- [x] Test: replace a local image, verify it uploads to Relay
- [x] Test: verify unchanged binary files are skipped (hash match)
