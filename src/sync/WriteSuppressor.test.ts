import { describe, test, expect, beforeEach } from "bun:test";
import { WriteSuppressor } from "./WriteSuppressor";

describe("WriteSuppressor", () => {
  let suppressor: WriteSuppressor;

  beforeEach(() => {
    suppressor = new WriteSuppressor();
  });

  test("isSuppressed returns false for unknown paths", () => {
    expect(suppressor.isSuppressed("/unknown.md")).toBe(false);
  });

  test("isSuppressed returns true immediately after suppress()", () => {
    suppressor.suppress("/test.md");
    expect(suppressor.isSuppressed("/test.md")).toBe(true);
  });

  test("suppress expires after ~2 seconds", async () => {
    suppressor.suppress("/test.md");
    expect(suppressor.isSuppressed("/test.md")).toBe(true);

    await new Promise((r) => setTimeout(r, 2200));
    expect(suppressor.isSuppressed("/test.md")).toBe(false);
  });

  test("calling suppress again resets the timer", async () => {
    suppressor.suppress("/test.md");
    await new Promise((r) => setTimeout(r, 1500));
    // Re-suppress -- should reset the 2s window
    suppressor.suppress("/test.md");
    await new Promise((r) => setTimeout(r, 1000));
    // Should still be suppressed (only 1s into the new 2s window)
    expect(suppressor.isSuppressed("/test.md")).toBe(true);
  });

  test("clear removes all suppressions immediately", () => {
    suppressor.suppress("/a.md");
    suppressor.suppress("/b.md");
    expect(suppressor.isSuppressed("/a.md")).toBe(true);
    expect(suppressor.isSuppressed("/b.md")).toBe(true);

    suppressor.clear();
    expect(suppressor.isSuppressed("/a.md")).toBe(false);
    expect(suppressor.isSuppressed("/b.md")).toBe(false);
  });

  test("different paths are independent", () => {
    suppressor.suppress("/a.md");
    expect(suppressor.isSuppressed("/a.md")).toBe(true);
    expect(suppressor.isSuppressed("/b.md")).toBe(false);
  });
});
