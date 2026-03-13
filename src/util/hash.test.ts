import { describe, test, expect } from "bun:test";
import { sha256Hex, sha256File } from "./hash";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("sha256Hex", () => {
  test("known input produces known SHA256 hash", () => {
    const hash = sha256Hex("hello");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("works with string input", () => {
    const hash = sha256Hex("abc");
    expect(hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("works with Uint8Array input", () => {
    const data = new TextEncoder().encode("hello");
    const hash = sha256Hex(data);
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("works with ArrayBuffer input", () => {
    const data = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    const hash = sha256Hex(data);
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("empty input produces correct hash", () => {
    const hash = sha256Hex("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("sha256File", () => {
  test("hashing a temp file matches sha256Hex of same content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hash-test-"));
    const filePath = join(dir, "test.txt");
    const content = "hello world";

    try {
      await writeFile(filePath, content, "utf-8");

      const fileHash = await sha256File(filePath);
      const directHash = sha256Hex(content);

      expect(fileHash).toBe(directHash);
      expect(fileHash).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
