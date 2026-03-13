import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as Y from "yjs";
import { DocStore } from "./DocStore";

let tempDir: string;
let store: DocStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "docstore-test-"));
  store = new DocStore(tempDir);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe("DocStore", () => {
  test("save + load roundtrip preserves text content", async () => {
    const doc1 = new Y.Doc();
    doc1.getText("content").insert(0, "Hello from Yjs!");
    await store.save("test-doc", doc1);

    const doc2 = new Y.Doc();
    const loaded = await store.load("test-doc", doc2);
    expect(loaded).toBe(true);
    expect(doc2.getText("content").toString()).toBe("Hello from Yjs!");
  });

  test("load returns false when no persisted state", async () => {
    const doc = new Y.Doc();
    const loaded = await store.load("nonexistent", doc);
    expect(loaded).toBe(false);
  });

  test("load returns true when state exists", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "exists");
    await store.save("exists-doc", doc);

    const doc2 = new Y.Doc();
    const loaded = await store.load("exists-doc", doc2);
    expect(loaded).toBe(true);
  });

  test("save creates persistence directory if needed", async () => {
    const nestedDir = join(tempDir, "deep", "nested");
    const nestedStore = new DocStore(nestedDir);

    const doc = new Y.Doc();
    doc.getText("content").insert(0, "nested save");
    // Should not throw -- mkdir is called with { recursive: true }
    await nestedStore.save("nested-doc", doc);

    const doc2 = new Y.Doc();
    const loaded = await nestedStore.load("nested-doc", doc2);
    expect(loaded).toBe(true);
    expect(doc2.getText("content").toString()).toBe("nested save");
  });

  test("safePath rejects path traversal", async () => {
    const doc = new Y.Doc();
    expect(store.save("../../etc/passwd", doc)).rejects.toThrow("Path traversal detected");
  });

  test("multiple saves overwrite correctly", async () => {
    const doc1 = new Y.Doc();
    doc1.getText("content").insert(0, "version 1");
    await store.save("overwrite-doc", doc1);

    const doc2 = new Y.Doc();
    doc2.getText("content").insert(0, "version 2");
    await store.save("overwrite-doc", doc2);

    const doc3 = new Y.Doc();
    const loaded = await store.load("overwrite-doc", doc3);
    expect(loaded).toBe(true);
    expect(doc3.getText("content").toString()).toBe("version 2");
  });
});
