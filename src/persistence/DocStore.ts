import * as Y from "yjs";
import { mkdir, rename } from "fs/promises";
import { dirname, join, resolve } from "path";
import { logger } from "../util/logger";

/**
 * Persists Y.Doc state as binary snapshots to disk.
 * Enables incremental sync on restart by loading the previous state
 * before connecting -- Yjs sync protocol will only exchange the delta.
 */
export class DocStore {
  constructor(private persistenceDir: string) {}

  /**
   * Save a Y.Doc's full state as a binary update to `{docId}.ystate`.
   */
  /**
   * Resolve a doc path and verify it doesn't escape the persistence directory.
   */
  private safePath(docId: string): string {
    const path = resolve(join(this.persistenceDir, `${docId}.ystate`));
    const normalizedDir = resolve(this.persistenceDir);
    if (!path.startsWith(normalizedDir + "/") && path !== normalizedDir) {
      throw new Error(`Path traversal detected: "${docId}" resolves outside persistence directory`);
    }
    return path;
  }

  async save(docId: string, ydoc: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(ydoc);
    const path = this.safePath(docId);
    const tmpPath = path + ".tmp";
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(tmpPath, state);
    await rename(tmpPath, path);
    logger.debug(`Persisted Y.Doc state for ${docId} (${state.byteLength} bytes)`);
  }

  /**
   * Load persisted state into a Y.Doc.
   * Returns true if state was found and applied, false otherwise.
   */
  async load(docId: string, ydoc: Y.Doc): Promise<boolean> {
    const path = this.safePath(docId);
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const state = new Uint8Array(await file.arrayBuffer());
        Y.applyUpdate(ydoc, state);
        logger.debug(`Loaded persisted Y.Doc state for ${docId} (${state.byteLength} bytes)`);
        return true;
      }
    } catch {
      // First run or corrupted state file -- start fresh
      logger.debug(`No persisted state for ${docId}`);
    }
    return false;
  }
}
