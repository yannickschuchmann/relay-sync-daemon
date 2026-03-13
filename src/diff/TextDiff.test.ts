import { describe, test, expect } from "bun:test";
import * as Y from "yjs";
import { applyTextToYDoc } from "./TextDiff";

function createDoc(initialContent?: string): Y.Doc {
  const ydoc = new Y.Doc();
  if (initialContent) {
    ydoc.getText("contents").insert(0, initialContent);
  }
  return ydoc;
}

function getContents(ydoc: Y.Doc): string {
  return ydoc.getText("contents").toString();
}

describe("applyTextToYDoc", () => {
  test("apply text to empty Y.Doc", () => {
    const ydoc = createDoc();
    applyTextToYDoc(ydoc, "hello world");
    expect(getContents(ydoc)).toBe("hello world");
  });

  test("modify existing content", () => {
    const ydoc = createDoc("old content");
    applyTextToYDoc(ydoc, "new content");
    expect(getContents(ydoc)).toBe("new content");
  });

  test("no-op when content is identical", () => {
    const ydoc = createDoc("same content");
    let transactionFired = false;
    ydoc.on("update", () => {
      transactionFired = true;
    });
    applyTextToYDoc(ydoc, "same content");
    expect(transactionFired).toBe(false);
    expect(getContents(ydoc)).toBe("same content");
  });

  test("insert at beginning", () => {
    const ydoc = createDoc("world");
    applyTextToYDoc(ydoc, "hello world");
    expect(getContents(ydoc)).toBe("hello world");
  });

  test("insert at end", () => {
    const ydoc = createDoc("hello");
    applyTextToYDoc(ydoc, "hello world");
    expect(getContents(ydoc)).toBe("hello world");
  });

  test("delete from middle", () => {
    const ydoc = createDoc("hello beautiful world");
    applyTextToYDoc(ydoc, "hello world");
    expect(getContents(ydoc)).toBe("hello world");
  });

  test("replace all content", () => {
    const ydoc = createDoc("the quick brown fox");
    applyTextToYDoc(ydoc, "completely different text here");
    expect(getContents(ydoc)).toBe("completely different text here");
  });

  test("handle empty string - clears content", () => {
    const ydoc = createDoc("some content to clear");
    applyTextToYDoc(ydoc, "");
    expect(getContents(ydoc)).toBe("");
  });

  test("handle unicode and emoji", () => {
    const ydoc = createDoc();
    applyTextToYDoc(ydoc, "hello 🌍");
    expect(getContents(ydoc)).toBe("hello 🌍");
  });

  test("transaction origin is 'local-edit'", () => {
    const ydoc = createDoc("before");
    let capturedOrigin: unknown = null;
    ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
      capturedOrigin = origin;
    });
    applyTextToYDoc(ydoc, "after");
    expect(capturedOrigin).toBe("local-edit");
  });

  test("multiple sequential applies", () => {
    const ydoc = createDoc();
    applyTextToYDoc(ydoc, "first");
    expect(getContents(ydoc)).toBe("first");

    applyTextToYDoc(ydoc, "second");
    expect(getContents(ydoc)).toBe("second");

    applyTextToYDoc(ydoc, "third and final");
    expect(getContents(ydoc)).toBe("third and final");

    applyTextToYDoc(ydoc, "");
    expect(getContents(ydoc)).toBe("");

    applyTextToYDoc(ydoc, "back again");
    expect(getContents(ydoc)).toBe("back again");
  });

  test("large text replacement", () => {
    const largeText = "a".repeat(10000);
    const ydoc = createDoc();
    applyTextToYDoc(ydoc, largeText);
    expect(getContents(ydoc)).toBe(largeText);
    expect(getContents(ydoc).length).toBe(10000);

    const differentLargeText = "b".repeat(10000);
    applyTextToYDoc(ydoc, differentLargeText);
    expect(getContents(ydoc)).toBe(differentLargeText);
  });
});
