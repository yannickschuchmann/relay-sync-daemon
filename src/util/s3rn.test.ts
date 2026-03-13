import { describe, test, expect } from "bun:test";
import {
  validateUUID,
  encodeS3RN,
  decodeS3RN,
  folderS3RN,
  documentS3RN,
  canvasS3RN,
  fileS3RN,
  type S3RNRelay,
  type S3RNFolder,
  type S3RNDocument,
  type S3RNCanvas,
  type S3RNFile,
  type S3RNBlob,
} from "./s3rn";

const UUID1 = "47659acd-052f-4577-b22d-d537c4322e83";
const UUID2 = "1f79edc8-627a-4281-ad82-2485839c8ddf";

describe("validateUUID", () => {
  test("accepts a valid UUID", () => {
    expect(validateUUID(UUID1)).toBe(true);
    expect(validateUUID(UUID2)).toBe(true);
  });

  test("rejects invalid strings", () => {
    expect(validateUUID("not-a-uuid")).toBe(false);
    expect(validateUUID("12345")).toBe(false);
    expect(validateUUID("47659acd-052f-4577-b22d")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(validateUUID("")).toBe(false);
  });

  test("accepts uppercase UUID", () => {
    expect(validateUUID(UUID1.toUpperCase())).toBe(true);
  });
});

describe("encodeS3RN", () => {
  test("encodes relay", () => {
    const resource: S3RNRelay = { kind: "relay", relayId: UUID1 };
    expect(encodeS3RN(resource)).toBe(`s3rn:relay:relay:${UUID1}`);
  });

  test("encodes folder", () => {
    const resource: S3RNFolder = { kind: "folder", relayId: UUID1, folderId: UUID2 };
    expect(encodeS3RN(resource)).toBe(`s3rn:relay:relay:${UUID1}:folder:${UUID2}`);
  });

  test("encodes doc", () => {
    const resource: S3RNDocument = { kind: "doc", relayId: UUID1, folderId: UUID2, documentId: UUID1 };
    expect(encodeS3RN(resource)).toBe(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:doc:${UUID1}`);
  });

  test("encodes canvas", () => {
    const resource: S3RNCanvas = { kind: "canvas", relayId: UUID1, folderId: UUID2, canvasId: UUID1 };
    expect(encodeS3RN(resource)).toBe(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:canvas:${UUID1}`);
  });

  test("encodes file", () => {
    const resource: S3RNFile = { kind: "file", relayId: UUID1, folderId: UUID2, fileId: UUID1 };
    expect(encodeS3RN(resource)).toBe(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:file:${UUID1}`);
  });

  test("encodes blob", () => {
    const resource: S3RNBlob = {
      kind: "blob",
      relayId: UUID1,
      folderId: UUID2,
      fileId: UUID1,
      hash: "abc123",
      contentType: "image/png",
      contentLength: "1024",
    };
    expect(encodeS3RN(resource)).toBe(
      `s3rn:relay:relay:${UUID1}:folder:${UUID2}:file:${UUID1}:sha256:abc123:contentType:image/png:contentLength:1024`,
    );
  });
});

describe("decodeS3RN", () => {
  test("parses relay", () => {
    const result = decodeS3RN(`s3rn:relay:relay:${UUID1}`);
    expect(result).toEqual({ kind: "relay", relayId: UUID1 });
  });

  test("parses folder", () => {
    const result = decodeS3RN(`s3rn:relay:relay:${UUID1}:folder:${UUID2}`);
    expect(result).toEqual({ kind: "folder", relayId: UUID1, folderId: UUID2 });
  });

  test("parses doc", () => {
    const result = decodeS3RN(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:doc:${UUID1}`);
    expect(result).toEqual({ kind: "doc", relayId: UUID1, folderId: UUID2, documentId: UUID1 });
  });

  test("parses canvas", () => {
    const result = decodeS3RN(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:canvas:${UUID1}`);
    expect(result).toEqual({ kind: "canvas", relayId: UUID1, folderId: UUID2, canvasId: UUID1 });
  });

  test("parses file", () => {
    const result = decodeS3RN(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:file:${UUID1}`);
    expect(result).toEqual({ kind: "file", relayId: UUID1, folderId: UUID2, fileId: UUID1 });
  });

  test("parses blob", () => {
    const s3rn = `s3rn:relay:relay:${UUID1}:folder:${UUID2}:file:${UUID1}:sha256:abc123:contentType:image/png:contentLength:1024`;
    const result = decodeS3RN(s3rn);
    expect(result).toEqual({
      kind: "blob",
      relayId: UUID1,
      folderId: UUID2,
      fileId: UUID1,
      hash: "abc123",
      contentType: "image/png",
      contentLength: "1024",
    });
  });
});

describe("roundtrip encode/decode", () => {
  test("relay roundtrip", () => {
    const resource: S3RNRelay = { kind: "relay", relayId: UUID1 };
    expect(decodeS3RN(encodeS3RN(resource))).toEqual(resource);
  });

  test("folder roundtrip", () => {
    const resource: S3RNFolder = { kind: "folder", relayId: UUID1, folderId: UUID2 };
    expect(decodeS3RN(encodeS3RN(resource))).toEqual(resource);
  });

  test("doc roundtrip", () => {
    const resource: S3RNDocument = { kind: "doc", relayId: UUID1, folderId: UUID2, documentId: UUID1 };
    expect(decodeS3RN(encodeS3RN(resource))).toEqual(resource);
  });

  test("canvas roundtrip", () => {
    const resource: S3RNCanvas = { kind: "canvas", relayId: UUID1, folderId: UUID2, canvasId: UUID1 };
    expect(decodeS3RN(encodeS3RN(resource))).toEqual(resource);
  });

  test("file roundtrip", () => {
    const resource: S3RNFile = { kind: "file", relayId: UUID1, folderId: UUID2, fileId: UUID1 };
    expect(decodeS3RN(encodeS3RN(resource))).toEqual(resource);
  });

  test("blob roundtrip", () => {
    const resource: S3RNBlob = {
      kind: "blob",
      relayId: UUID1,
      folderId: UUID2,
      fileId: UUID1,
      hash: "deadbeef",
      contentType: "application/pdf",
      contentLength: "2048",
    };
    expect(decodeS3RN(encodeS3RN(resource))).toEqual(resource);
  });
});

describe("decodeS3RN error cases", () => {
  test("throws on invalid prefix", () => {
    expect(() => decodeS3RN("bad:prefix:relay:uuid")).toThrow("Invalid S3RN");
  });

  test("throws on missing segments", () => {
    expect(() => decodeS3RN("s3rn:relay")).toThrow("Invalid S3RN");
  });

  test("throws on invalid UUID in S3RN", () => {
    expect(() => decodeS3RN("s3rn:relay:relay:not-a-uuid")).toThrow("Invalid UUID");
  });

  test("throws on unknown type segment", () => {
    expect(() =>
      decodeS3RN(`s3rn:relay:relay:${UUID1}:folder:${UUID2}:unknown:${UUID1}`),
    ).toThrow('unknown type segment "unknown"');
  });
});

describe("convenience builders", () => {
  test("folderS3RN produces correct string", () => {
    expect(folderS3RN(UUID1, UUID2)).toBe(`s3rn:relay:relay:${UUID1}:folder:${UUID2}`);
  });

  test("documentS3RN produces correct string", () => {
    expect(documentS3RN(UUID1, UUID2, UUID1)).toBe(
      `s3rn:relay:relay:${UUID1}:folder:${UUID2}:doc:${UUID1}`,
    );
  });

  test("canvasS3RN produces correct string", () => {
    expect(canvasS3RN(UUID1, UUID2, UUID1)).toBe(
      `s3rn:relay:relay:${UUID1}:folder:${UUID2}:canvas:${UUID1}`,
    );
  });

  test("fileS3RN produces correct string", () => {
    expect(fileS3RN(UUID1, UUID2, UUID1)).toBe(
      `s3rn:relay:relay:${UUID1}:folder:${UUID2}:file:${UUID1}`,
    );
  });
});
