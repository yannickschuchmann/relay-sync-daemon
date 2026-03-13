/**
 * S3RN (System3 Resource Name) - encode/decode resource identifiers.
 * Ported from context/Relay/src/S3RN.ts with a simplified functional API.
 *
 * Format: s3rn:relay:relay:{relayId}:folder:{folderId}[:doc|canvas|file:{id}]
 */

export type UUID = string;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(uuid: string): boolean {
  return UUID_REGEX.test(uuid);
}

// --- Decoded resource types ---

export interface S3RNRelay {
  kind: "relay";
  relayId: UUID;
}

export interface S3RNFolder {
  kind: "folder";
  relayId: UUID;
  folderId: UUID;
}

export interface S3RNDocument {
  kind: "doc";
  relayId: UUID;
  folderId: UUID;
  documentId: UUID;
}

export interface S3RNCanvas {
  kind: "canvas";
  relayId: UUID;
  folderId: UUID;
  canvasId: UUID;
}

export interface S3RNFile {
  kind: "file";
  relayId: UUID;
  folderId: UUID;
  fileId: UUID;
}

export interface S3RNBlob {
  kind: "blob";
  relayId: UUID;
  folderId: UUID;
  fileId: UUID;
  hash: string;
  contentType: string;
  contentLength: string;
}

export type S3RNResource =
  | S3RNRelay
  | S3RNFolder
  | S3RNDocument
  | S3RNCanvas
  | S3RNFile
  | S3RNBlob;

// --- Encode ---

export function encodeS3RN(resource: S3RNResource): string {
  switch (resource.kind) {
    case "relay":
      assertUUID(resource.relayId, "relayId");
      return `s3rn:relay:relay:${resource.relayId}`;

    case "folder":
      assertUUID(resource.relayId, "relayId");
      assertUUID(resource.folderId, "folderId");
      return `s3rn:relay:relay:${resource.relayId}:folder:${resource.folderId}`;

    case "doc":
      assertUUID(resource.relayId, "relayId");
      assertUUID(resource.folderId, "folderId");
      assertUUID(resource.documentId, "documentId");
      return `s3rn:relay:relay:${resource.relayId}:folder:${resource.folderId}:doc:${resource.documentId}`;

    case "canvas":
      assertUUID(resource.relayId, "relayId");
      assertUUID(resource.folderId, "folderId");
      assertUUID(resource.canvasId, "canvasId");
      return `s3rn:relay:relay:${resource.relayId}:folder:${resource.folderId}:canvas:${resource.canvasId}`;

    case "file":
      assertUUID(resource.relayId, "relayId");
      assertUUID(resource.folderId, "folderId");
      assertUUID(resource.fileId, "fileId");
      return `s3rn:relay:relay:${resource.relayId}:folder:${resource.folderId}:file:${resource.fileId}`;

    case "blob":
      assertUUID(resource.relayId, "relayId");
      assertUUID(resource.folderId, "folderId");
      assertUUID(resource.fileId, "fileId");
      return (
        `s3rn:relay:relay:${resource.relayId}:folder:${resource.folderId}:file:${resource.fileId}` +
        `:sha256:${resource.hash}:contentType:${resource.contentType}:contentLength:${resource.contentLength}`
      );
  }
}

// --- Decode ---

export function decodeS3RN(s3rn: string): S3RNResource {
  const parts = s3rn.split(":");
  if (parts.length < 4 || parts[0] !== "s3rn" || parts[1] !== "relay") {
    throw new Error(`Invalid S3RN: must start with "s3rn:relay:", got "${s3rn}"`);
  }

  // parts[2] = "relay", parts[3] = relayId
  if (parts[2] !== "relay") {
    throw new Error(`Invalid S3RN: expected "relay" segment, got "${parts[2]}"`);
  }

  const relayId = parts[3];
  assertUUID(relayId, "relayId");

  // s3rn:relay:relay:{relayId}
  if (parts.length === 4) {
    return { kind: "relay", relayId };
  }

  // parts[4] = "folder", parts[5] = folderId
  if (parts[4] !== "folder" || !parts[5]) {
    throw new Error(`Invalid S3RN: expected "folder" segment at position 4`);
  }

  const folderId = parts[5];
  assertUUID(folderId, "folderId");

  // s3rn:relay:relay:{relayId}:folder:{folderId}
  if (parts.length === 6) {
    return { kind: "folder", relayId, folderId };
  }

  // parts[6] = type segment, parts[7] = id
  const typeSegment = parts[6];
  const itemId = parts[7];

  if (!itemId) {
    throw new Error(`Invalid S3RN: missing ID after "${typeSegment}" segment`);
  }

  switch (typeSegment) {
    case "doc":
      assertUUID(itemId, "documentId");
      return { kind: "doc", relayId, folderId, documentId: itemId };

    case "canvas":
      assertUUID(itemId, "canvasId");
      return { kind: "canvas", relayId, folderId, canvasId: itemId };

    case "file": {
      assertUUID(itemId, "fileId");

      // Check for blob extension: :sha256:{hash}:contentType:{ct}:contentLength:{cl}
      if (parts.length > 8 && parts[8] === "sha256") {
        const hash = parts[9];
        if (parts[10] !== "contentType" || parts[12] !== "contentLength") {
          throw new Error("Invalid S3RN blob format");
        }
        const contentType = parts[11];
        const contentLength = parts[13];
        return {
          kind: "blob",
          relayId,
          folderId,
          fileId: itemId,
          hash,
          contentType,
          contentLength,
        };
      }

      return { kind: "file", relayId, folderId, fileId: itemId };
    }

    default:
      throw new Error(`Invalid S3RN: unknown type segment "${typeSegment}"`);
  }
}

// --- Convenience builders ---

export function folderS3RN(relayId: UUID, folderId: UUID): string {
  return encodeS3RN({ kind: "folder", relayId, folderId });
}

export function documentS3RN(relayId: UUID, folderId: UUID, documentId: UUID): string {
  return encodeS3RN({ kind: "doc", relayId, folderId, documentId });
}

export function canvasS3RN(relayId: UUID, folderId: UUID, canvasId: UUID): string {
  return encodeS3RN({ kind: "canvas", relayId, folderId, canvasId });
}

export function fileS3RN(relayId: UUID, folderId: UUID, fileId: UUID): string {
  return encodeS3RN({ kind: "file", relayId, folderId, fileId });
}

// --- Internal helpers ---

function assertUUID(value: string, label: string): void {
  if (!validateUUID(value)) {
    throw new Error(`Invalid UUID for ${label}: "${value}"`);
  }
}
