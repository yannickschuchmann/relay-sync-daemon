import { describe, test, expect } from "bun:test";
import {
  SyncType,
  isBinaryType,
  isTextType,
  getMimeTypeForExtension,
  getSyncTypeForMimetype,
  RELAY_VERSION,
} from "./types";

describe("isBinaryType", () => {
  test("returns true for binary types", () => {
    expect(isBinaryType(SyncType.Image)).toBe(true);
    expect(isBinaryType(SyncType.PDF)).toBe(true);
    expect(isBinaryType(SyncType.Audio)).toBe(true);
    expect(isBinaryType(SyncType.Video)).toBe(true);
    expect(isBinaryType(SyncType.File)).toBe(true);
  });

  test("returns false for non-binary types", () => {
    expect(isBinaryType(SyncType.Document)).toBe(false);
    expect(isBinaryType(SyncType.Canvas)).toBe(false);
    expect(isBinaryType(SyncType.Folder)).toBe(false);
  });
});

describe("isTextType", () => {
  test("returns true for text types", () => {
    expect(isTextType(SyncType.Document)).toBe(true);
    expect(isTextType(SyncType.Canvas)).toBe(true);
  });

  test("returns false for binary types and Folder", () => {
    expect(isTextType(SyncType.Image)).toBe(false);
    expect(isTextType(SyncType.PDF)).toBe(false);
    expect(isTextType(SyncType.Audio)).toBe(false);
    expect(isTextType(SyncType.Video)).toBe(false);
    expect(isTextType(SyncType.File)).toBe(false);
    expect(isTextType(SyncType.Folder)).toBe(false);
  });
});

describe("getMimeTypeForExtension", () => {
  test("returns correct MIME type for image extensions", () => {
    expect(getMimeTypeForExtension("png")).toBe("image/png");
    expect(getMimeTypeForExtension("jpg")).toBe("image/jpeg");
    expect(getMimeTypeForExtension("jpeg")).toBe("image/jpeg");
    expect(getMimeTypeForExtension("gif")).toBe("image/gif");
    expect(getMimeTypeForExtension("svg")).toBe("image/svg+xml");
    expect(getMimeTypeForExtension("webp")).toBe("image/webp");
    expect(getMimeTypeForExtension("bmp")).toBe("image/bmp");
    expect(getMimeTypeForExtension("ico")).toBe("image/x-icon");
  });

  test("returns correct MIME type for markdown", () => {
    expect(getMimeTypeForExtension("md")).toBe("text/markdown");
  });

  test("returns correct MIME type for PDF", () => {
    expect(getMimeTypeForExtension("pdf")).toBe("application/pdf");
  });

  test("returns correct MIME type for audio extensions", () => {
    expect(getMimeTypeForExtension("mp3")).toBe("audio/mpeg");
    expect(getMimeTypeForExtension("wav")).toBe("audio/wav");
    expect(getMimeTypeForExtension("flac")).toBe("audio/flac");
    expect(getMimeTypeForExtension("ogg")).toBe("audio/ogg");
    expect(getMimeTypeForExtension("m4a")).toBe("audio/x-m4a");
    expect(getMimeTypeForExtension("aac")).toBe("audio/aac");
  });

  test("returns correct MIME type for video extensions", () => {
    expect(getMimeTypeForExtension("mp4")).toBe("video/mp4");
    expect(getMimeTypeForExtension("webm")).toBe("video/webm");
    expect(getMimeTypeForExtension("mkv")).toBe("video/x-matroska");
    expect(getMimeTypeForExtension("mov")).toBe("video/quicktime");
    expect(getMimeTypeForExtension("avi")).toBe("video/x-msvideo");
  });

  test("returns correct MIME type for canvas", () => {
    expect(getMimeTypeForExtension("canvas")).toBe("application/canvas+json");
  });

  test("returns application/octet-stream for unknown extensions", () => {
    expect(getMimeTypeForExtension("xyz")).toBe("application/octet-stream");
    expect(getMimeTypeForExtension("unknown")).toBe("application/octet-stream");
  });

  test("is case-insensitive", () => {
    expect(getMimeTypeForExtension("PNG")).toBe("image/png");
    expect(getMimeTypeForExtension("Jpg")).toBe("image/jpeg");
  });
});

describe("getSyncTypeForMimetype", () => {
  test("maps text/markdown to Document", () => {
    expect(getSyncTypeForMimetype("text/markdown")).toBe(SyncType.Document);
  });

  test("maps application/canvas+json to Canvas", () => {
    expect(getSyncTypeForMimetype("application/canvas+json")).toBe(SyncType.Canvas);
  });

  test("maps image/* to Image", () => {
    expect(getSyncTypeForMimetype("image/png")).toBe(SyncType.Image);
    expect(getSyncTypeForMimetype("image/jpeg")).toBe(SyncType.Image);
    expect(getSyncTypeForMimetype("image/svg+xml")).toBe(SyncType.Image);
  });

  test("maps application/pdf to PDF", () => {
    expect(getSyncTypeForMimetype("application/pdf")).toBe(SyncType.PDF);
  });

  test("maps audio/* to Audio", () => {
    expect(getSyncTypeForMimetype("audio/mpeg")).toBe(SyncType.Audio);
    expect(getSyncTypeForMimetype("audio/wav")).toBe(SyncType.Audio);
  });

  test("maps video/* to Video", () => {
    expect(getSyncTypeForMimetype("video/mp4")).toBe(SyncType.Video);
    expect(getSyncTypeForMimetype("video/webm")).toBe(SyncType.Video);
  });

  test("maps unknown MIME types to File", () => {
    expect(getSyncTypeForMimetype("application/octet-stream")).toBe(SyncType.File);
    expect(getSyncTypeForMimetype("application/zip")).toBe(SyncType.File);
  });
});

describe("RELAY_VERSION", () => {
  test("is 0.7.4", () => {
    expect(RELAY_VERSION).toBe("0.7.4");
  });
});
