# Relay Sync Daemon

A headless TypeScript/Bun daemon that bidirectionally syncs a [Relay.md](https://relay.md) shared folder to a local directory. Designed to run on a VPS or any always-on machine.

## How It Works

The daemon connects to Relay's collaboration network using the same Yjs CRDT protocol as the Obsidian plugin. It:

1. Authenticates with PocketBase and obtains WebSocket tokens
2. Connects to the shared folder's Y.Doc to discover all files
3. Downloads each document (markdown, canvas) and binary file (images, PDFs, audio, video)
4. Watches for remote changes and writes them to disk in real-time
5. Watches for local file changes and pushes them to Relay via CRDT diffs
6. Handles file creation, deletion, and renames in both directions

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A Relay.md account with access to a shared folder
- A PocketBase auth token (JWT) from your Relay session

## Quick Start

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
# Edit .env with your values (see Configuration below)

# Run the daemon
bun start
```

## Configuration

Create a `.env` file with the following variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAY_GUID` | Yes | — | UUID of the relay |
| `FOLDER_GUID` | Yes | — | UUID of the shared folder |
| `SYNC_DIR` | Yes | — | Local directory to sync files to |
| `RELAY_TOKEN` | First run | — | PocketBase JWT for initial auth bootstrap |
| `API_URL` | No | `https://api.system3.md` | Relay API base URL |
| `AUTH_URL` | No | `https://auth.system3.md` | PocketBase auth URL |
| `DEBOUNCE_MS` | No | `2000` | Delay before pushing local changes (ms) |
| `PERSISTENCE_DIR` | No | `SYNC_DIR/.relay-sync` | Directory for Y.Doc state and auth tokens |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |

### Getting Your Relay GUID and Folder GUID

These can be found in the Relay.md Obsidian plugin settings, or by inspecting the plugin's `data.json` file in your vault's `.obsidian/plugins/relay-md/` directory.

### Getting a RELAY_TOKEN

The `RELAY_TOKEN` is a PocketBase JWT. You can obtain it from:
- The Obsidian plugin's local storage (key format: `pocketbase_auth_{vaultName}`)
- Your browser's developer tools if logged into the Relay web interface

The token is only needed for the initial bootstrap. After the first successful authentication, the daemon persists and auto-refreshes its own token in `PERSISTENCE_DIR/.relay-auth`. Subsequent restarts do not need `RELAY_TOKEN`.

## Usage

```bash
# Production
bun start

# Development (auto-restart on code changes)
bun run dev

# Type checking
bun run typecheck
```

### Running as a System Service

Create a systemd service file at `/etc/systemd/system/relay-sync.service`:

```ini
[Unit]
Description=Relay Sync Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/relay-sync-daemon
EnvironmentFile=/opt/relay-sync-daemon/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable relay-sync
sudo systemctl start relay-sync
sudo journalctl -u relay-sync -f  # view logs
```

## Architecture

```
Relay Server  <--Yjs WebSocket-->  Sync Daemon  <--read/write-->  Local Disk
(y-sweet)          sync protocol   (Bun process)                   (SYNC_DIR)
```

- **Text files** (`.md`, `.canvas`) are synced via Yjs CRDTs — concurrent edits from multiple clients merge automatically.
- **Binary files** (images, PDFs, audio, video) use content-addressed storage with SHA256 hashing. Only changed files are uploaded/downloaded.
- **Y.Doc state** is persisted to disk every 30 seconds and on shutdown, so restarts only sync the delta.

## Sync Behavior

| Scenario | Behavior |
|----------|----------|
| Remote edit | Written to disk after 300ms debounce |
| Local edit | Pushed to Relay after 2s debounce (configurable) |
| Remote file added | Downloaded and saved to disk |
| Local file added | Created in Relay with new document ID |
| File deleted (either side) | Deleted on the other side |
| File renamed locally | Detected via unlink+add correlation (500ms window) |
| Binary file changed | Hash compared; only re-uploaded/downloaded if different |
| Concurrent text edits | Merged automatically by Yjs CRDT |
| Connection lost | Exponential backoff reconnection with automatic token refresh |
| Daemon restart | Incremental sync from persisted Y.Doc state |

## Project Structure

```
src/
  index.ts                  # Entry point, lifecycle management
  config.ts                 # Environment variable loading & validation
  auth/
    AuthManager.ts          # PocketBase auth (bootstrap, refresh, persistence)
    TokenStore.ts           # ClientToken cache & refresh for WebSocket connections
  sync/
    FolderSync.ts           # Folder Y.Doc connection, filemeta observation
    DocumentSync.ts         # Per-document Y.Doc connection & text sync
    BinarySync.ts           # Binary file upload/download via presigned URLs
    SyncCoordinator.ts      # Orchestrates all sync, manages lifecycle
  protocol/
    YSweetProvider.ts       # WebSocket provider for Yjs (ported from plugin)
    messages.ts             # Message type constants & handlers
    types.ts                # Shared types, enums, helpers
  fs/
    DiskManager.ts          # Atomic file read/write operations
    FileWatcher.ts          # chokidar wrapper for local file watching
  diff/
    TextDiff.ts             # diff-match-patch: local edits → Y.Text operations
  persistence/
    DocStore.ts             # Persist/restore Y.Doc state to disk
  util/
    s3rn.ts                 # S3RN resource name encode/decode
    hash.ts                 # SHA256 hashing
    logger.ts               # Structured logging with levels
    debounce.ts             # Debounce utility
```

## License

Private — not yet licensed for distribution.
