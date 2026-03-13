import { mkdir, writeFile, readFile, unlink, rename } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { logger } from "../util/logger";

/**
 * Manages reading and writing files to the local sync directory.
 * Uses atomic writes (.tmp + rename) to avoid triggering watchers with partial content.
 */
export class DiskManager {
  constructor(private syncDir: string) {}

  /**
   * Write a text document to disk atomically.
   * Creates parent directories as needed, writes to .tmp file, then renames.
   */
  async writeDocument(vpath: string, content: string): Promise<void> {
    const fullPath = this.toAbsolute(vpath);
    await mkdir(dirname(fullPath), { recursive: true });

    const tmpPath = fullPath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, fullPath);
  }

  /**
   * Read a text document from disk.
   */
  async readDocument(vpath: string): Promise<string> {
    const fullPath = this.toAbsolute(vpath);
    return readFile(fullPath, "utf-8");
  }

  /**
   * Delete a document from disk. Ignores errors if the file doesn't exist.
   */
  async deleteDocument(vpath: string): Promise<void> {
    const fullPath = this.toAbsolute(vpath);
    await unlink(fullPath).catch(() => {});
  }

  /**
   * Write binary content to disk atomically.
   * Creates parent directories as needed, writes to .tmp file, then renames.
   */
  async writeBinary(vpath: string, content: ArrayBuffer): Promise<void> {
    const fullPath = this.toAbsolute(vpath);
    await mkdir(dirname(fullPath), { recursive: true });

    const tmpPath = fullPath + ".tmp";
    await writeFile(tmpPath, Buffer.from(content));
    await rename(tmpPath, fullPath);
  }

  /**
   * Read binary content from disk.
   */
  async readBinary(vpath: string): Promise<ArrayBuffer> {
    const fullPath = this.toAbsolute(vpath);
    const buffer = await readFile(fullPath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  /**
   * Convert a virtual path (relative to sync dir) to an absolute path.
   * Throws if the resolved path escapes the sync directory (path traversal protection).
   */
  toAbsolute(vpath: string): string {
    const resolved = resolve(this.syncDir, vpath);
    const normalizedSyncDir = resolve(this.syncDir);
    if (!resolved.startsWith(normalizedSyncDir + "/") && resolved !== normalizedSyncDir) {
      throw new Error(`Path traversal detected: "${vpath}" resolves outside sync directory`);
    }
    return resolved;
  }

  /**
   * Convert an absolute path to a virtual path (relative to sync dir).
   */
  toVpath(absolutePath: string): string {
    const resolved = resolve(absolutePath);
    const normalizedSyncDir = resolve(this.syncDir);
    if (!resolved.startsWith(normalizedSyncDir + "/") && resolved !== normalizedSyncDir) {
      throw new Error(`Path traversal detected: "${absolutePath}" is outside sync directory`);
    }
    return relative(this.syncDir, resolved);
  }

  /**
   * Get the sync directory root.
   */
  getSyncDir(): string {
    return this.syncDir;
  }
}
