import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DiskManager } from "./DiskManager";

let tempDir: string;
let disk: DiskManager;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "diskmanager-test-"));
  disk = new DiskManager(tempDir);
});

afterAll(async () => {
  // Clean up all temp dirs created during tests
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe("DiskManager", () => {
  test("writeDocument + readDocument roundtrip", async () => {
    await disk.writeDocument("hello.txt", "Hello, world!");
    const content = await disk.readDocument("hello.txt");
    expect(content).toBe("Hello, world!");
  });

  test("writeDocument creates parent directories", async () => {
    await disk.writeDocument("a/b/c/deep.txt", "nested content");
    const content = await disk.readDocument("a/b/c/deep.txt");
    expect(content).toBe("nested content");
  });

  test("writeDocument overwrites existing file", async () => {
    await disk.writeDocument("overwrite.txt", "first");
    await disk.writeDocument("overwrite.txt", "second");
    const content = await disk.readDocument("overwrite.txt");
    expect(content).toBe("second");
  });

  test("readDocument throws for non-existent file", async () => {
    expect(disk.readDocument("does-not-exist.txt")).rejects.toThrow();
  });

  test("deleteDocument removes file", async () => {
    await disk.writeDocument("to-delete.txt", "bye");
    await disk.deleteDocument("to-delete.txt");
    expect(disk.readDocument("to-delete.txt")).rejects.toThrow();
  });

  test("deleteDocument doesn't throw for non-existent file", async () => {
    // Should not throw
    await disk.deleteDocument("never-existed.txt");
  });

  test("writeBinary + readBinary roundtrip", async () => {
    const bytes = new Uint8Array([0x00, 0x42, 0xff, 0x10, 0xab]);
    await disk.writeBinary("data.bin", bytes.buffer);
    const result = await disk.readBinary("data.bin");
    const resultBytes = new Uint8Array(result);
    expect(resultBytes).toEqual(bytes);
  });

  test("toAbsolute returns correct path", () => {
    const abs = disk.toAbsolute("foo/bar.txt");
    expect(abs).toBe(join(tempDir, "foo/bar.txt"));
  });

  test("toAbsolute throws on path traversal", () => {
    expect(() => disk.toAbsolute("../etc/passwd")).toThrow("Path traversal detected");
  });

  test("toVpath converts absolute back to relative", () => {
    const abs = join(tempDir, "some/file.txt");
    const vpath = disk.toVpath(abs);
    expect(vpath).toBe("some/file.txt");
  });

  test("toVpath throws on path outside sync dir", () => {
    expect(() => disk.toVpath("/tmp/outside/file.txt")).toThrow("Path traversal detected");
  });
});
