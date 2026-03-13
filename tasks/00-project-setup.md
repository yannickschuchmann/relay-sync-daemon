# Task 0: Project Setup

## Scaffolding
- [x] Create `relay-sync-daemon/` directory structure per PLAN.md
- [x] Create `package.json` with all dependencies (yjs, y-protocols, lib0, pocketbase, chokidar, diff-match-patch, jose) and dev dependencies (typescript, @types/diff-match-patch, bun-types)
- [x] Create `tsconfig.json` (ESNext, bundler moduleResolution, bun-types)
- [x] Create `bunfig.toml`
- [x] Create `.env.example` with all config vars documented
- [x] Run `bun install`

## Core Utilities
- [x] Implement `src/util/logger.ts` — structured logging with configurable LOG_LEVEL
- [x] Implement `src/util/debounce.ts` — generic debounce utility
- [x] Implement `src/util/s3rn.ts` — S3RN encode/decode (port from existing codebase)
- [x] Implement `src/util/hash.ts` — SHA256 hashing using Bun.CryptoHasher

## Types & Config
- [x] Implement `src/protocol/types.ts` — ClientToken, FileToken, Meta, DocumentMeta, FileMetas, SyncType enum, RELAY_VERSION constant, helper functions (isBinaryType, isTextType, getMimeTypeForExtension, getSyncTypeForMimetype)
- [x] Implement `src/config.ts` — loadConfig() that reads env vars, validates UUIDs, sets defaults, ensures syncDir exists

## Entry Point Skeleton
- [x] Create `src/index.ts` skeleton with arg parsing, config loading, and graceful shutdown handlers (SIGINT/SIGTERM)
- [x] Verify `bun run src/index.ts` starts without errors (even if it exits immediately)
