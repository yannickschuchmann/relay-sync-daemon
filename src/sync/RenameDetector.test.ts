import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RenameDetector } from "./RenameDetector";
import { SyncType, type DocumentMeta, type Meta } from "../protocol/types";

const makeMeta = (id = "doc-1"): DocumentMeta => ({
  version: 0,
  id,
  type: SyncType.Document,
});

describe("RenameDetector", () => {
  let detector: RenameDetector;

  beforeEach(() => {
    detector = new RenameDetector();
  });

  // -----------------------------------------------------------------------
  // bufferDelete + tryMatchRename
  // -----------------------------------------------------------------------

  describe("rename detection", () => {
    test("add + delete with matching content is detected as a rename", () => {
      const meta = makeMeta("doc-abc");
      const confirmSpy: string[] = [];

      detector.bufferDelete("/old.md", meta, (vpath) => {
        confirmSpy.push(vpath);
      });

      // Simulate an add with the same content
      const result = detector.tryMatchRename(
        "/new.md",
        "hello world",
        (oldVpath) => (oldVpath === "/old.md" ? "hello world" : null),
      );

      expect(result).not.toBeNull();
      expect(result!.oldVpath).toBe("/old.md");
      expect(result!.meta).toBe(meta);
      // The confirmed-delete callback should NOT have been called
      expect(confirmSpy).toHaveLength(0);
    });

    test("add + delete with different content is NOT a rename", () => {
      const meta = makeMeta();

      detector.bufferDelete("/old.md", meta, () => {});

      const result = detector.tryMatchRename(
        "/new.md",
        "different content",
        (oldVpath) => (oldVpath === "/old.md" ? "original content" : null),
      );

      expect(result).toBeNull();
    });

    test("add without a prior delete is NOT a rename", () => {
      const result = detector.tryMatchRename(
        "/new.md",
        "some content",
        () => null,
      );
      expect(result).toBeNull();
    });

    test("delete without a subsequent add fires the confirmed callback", async () => {
      const meta = makeMeta();
      const confirmSpy: string[] = [];

      detector.bufferDelete("/old.md", meta, (vpath) => {
        confirmSpy.push(vpath);
      });

      // Wait for the rename window to expire (1000ms default + margin)
      await new Promise((r) => setTimeout(r, 1200));

      expect(confirmSpy).toEqual(["/old.md"]);
      expect(detector.hasPending).toBe(false);
    });

    test("multiple pending deletes, only the matching one is consumed", () => {
      const meta1 = makeMeta("doc-1");
      const meta2 = makeMeta("doc-2");
      const confirmSpy: string[] = [];

      detector.bufferDelete("/a.md", meta1, (vp) => confirmSpy.push(vp));
      detector.bufferDelete("/b.md", meta2, (vp) => confirmSpy.push(vp));

      const result = detector.tryMatchRename(
        "/c.md",
        "content-b",
        (oldVpath) => {
          if (oldVpath === "/a.md") return "content-a";
          if (oldVpath === "/b.md") return "content-b";
          return null;
        },
      );

      expect(result).not.toBeNull();
      expect(result!.oldVpath).toBe("/b.md");
      expect(result!.meta).toBe(meta2);
      // /a.md should still be pending
      expect(detector.hasPending).toBe(true);
    });

    test("getOldContent returning null skips that candidate", () => {
      const meta = makeMeta();

      detector.bufferDelete("/old.md", meta, () => {});

      // getOldContent returns null -> no connection for old path
      const result = detector.tryMatchRename(
        "/new.md",
        "content",
        () => null,
      );

      expect(result).toBeNull();
      expect(detector.hasPending).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // flushAll
  // -----------------------------------------------------------------------

  describe("flushAll", () => {
    test("calls onConfirmedDelete for every pending delete", async () => {
      const deleted: string[] = [];

      detector.bufferDelete("/a.md", makeMeta("1"), () => {});
      detector.bufferDelete("/b.md", makeMeta("2"), () => {});

      await detector.flushAll(async (vpath) => {
        deleted.push(vpath);
      });

      expect(deleted.sort()).toEqual(["/a.md", "/b.md"]);
      expect(detector.hasPending).toBe(false);
    });

    test("flushAll on empty detector is a no-op", async () => {
      await detector.flushAll(async () => {
        throw new Error("should not be called");
      });
      expect(detector.hasPending).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // hasPending
  // -----------------------------------------------------------------------

  describe("hasPending", () => {
    test("is false initially", () => {
      expect(detector.hasPending).toBe(false);
    });

    test("is true after bufferDelete", () => {
      detector.bufferDelete("/x.md", makeMeta(), () => {});
      expect(detector.hasPending).toBe(true);
    });

    test("is false after successful match", () => {
      detector.bufferDelete("/x.md", makeMeta(), () => {});

      detector.tryMatchRename(
        "/y.md",
        "c",
        (old) => (old === "/x.md" ? "c" : null),
      );

      expect(detector.hasPending).toBe(false);
    });
  });
});
