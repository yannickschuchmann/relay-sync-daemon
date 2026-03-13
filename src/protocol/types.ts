/**
 * Protocol types for the Relay sync daemon.
 * Mirrors the types used by the Relay.md Obsidian plugin.
 */

/** Must be sent as "Relay-Version" header on all /token and /file-token API requests. */
export const RELAY_VERSION = "0.7.4";

/**
 * Token returned by POST /token for WebSocket connections.
 * Contains the WebSocket URL, docId, and short-lived auth token.
 */
export interface ClientToken {
  url: string;
  docId: string;
  token: string;
  folder: string;
  expiryTime?: number;
}

/**
 * Token returned by POST /file-token for binary file upload/download.
 */
export interface FileToken {
  baseUrl: string;
  token: string;
}

/**
 * SyncType identifies the kind of content a file represents in Relay.
 */
export enum SyncType {
  Folder = "folder",
  Document = "markdown",
  Canvas = "canvas",
  Image = "image",
  PDF = "pdf",
  Audio = "audio",
  Video = "video",
  File = "file",
}

/**
 * Base metadata for a document (markdown or canvas) tracked in filemeta_v0.
 */
export interface DocumentMeta {
  version: number;
  id: string;
  type: SyncType.Document | SyncType.Canvas;
}

/**
 * Metadata for a binary file tracked in filemeta_v0.
 * Binary files have additional hash and mimetype fields for CAS.
 */
export interface FileMetas {
  version: number;
  id: string;
  type: SyncType.Image | SyncType.PDF | SyncType.Audio | SyncType.Video | SyncType.File;
  hash: string;
  mimetype: string;
  synctime?: number;
}

/**
 * Union type for any metadata entry in filemeta_v0.
 */
export type Meta = DocumentMeta | FileMetas;

/**
 * Returns true if the given SyncType represents a binary file
 * (image, PDF, audio, video, or generic file).
 */
export function isBinaryType(type: SyncType): boolean {
  return [
    SyncType.Image,
    SyncType.PDF,
    SyncType.Audio,
    SyncType.Video,
    SyncType.File,
  ].includes(type);
}

/**
 * Returns true if the given SyncType represents a text-based document
 * (markdown or canvas).
 */
export function isTextType(type: SyncType): boolean {
  return type === SyncType.Document || type === SyncType.Canvas;
}

/**
 * Map file extensions to MIME types for binary file handling.
 */
export function getMimeTypeForExtension(ext: string): string {
  const map: Record<string, string> = {
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    // Markdown
    md: "text/markdown",
    // PDF
    pdf: "application/pdf",
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    m4a: "audio/x-m4a",
    aac: "audio/aac",
    // Video
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    // Canvas (Obsidian-specific)
    canvas: "application/canvas+json",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Determine the SyncType for a given MIME type.
 */
export function getSyncTypeForMimetype(mimetype: string): SyncType {
  if (mimetype === "text/markdown") return SyncType.Document;
  if (mimetype === "application/canvas+json") return SyncType.Canvas;
  if (mimetype.startsWith("image/")) return SyncType.Image;
  if (mimetype === "application/pdf") return SyncType.PDF;
  if (mimetype.startsWith("audio/")) return SyncType.Audio;
  if (mimetype.startsWith("video/")) return SyncType.Video;
  return SyncType.File;
}
