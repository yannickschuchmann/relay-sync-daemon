import type { Config } from "../config";
import type { AuthManager } from "../auth/AuthManager";
import type { FileMetas, FileToken } from "../protocol/types";
import { RELAY_VERSION } from "../protocol/types";
import { decodeS3RN, type S3RNFile } from "../util/s3rn";
import { sha256Hex } from "../util/hash";
import { logger } from "../util/logger";

/**
 * Handles binary file upload/download via content-addressed storage (CAS).
 *
 * Binary files (images, PDFs, audio, video) are stored in S3 behind presigned URLs.
 * The flow for each operation:
 *   1. Get a FileToken via POST /file-token with the file's S3RN, hash, content type, and size
 *   2. Use the FileToken to get a presigned upload/download URL
 *   3. Upload/download the actual file bytes to/from S3
 */
export class BinarySync {
  constructor(
    private config: Config,
    private authManager: AuthManager,
  ) {}

  /**
   * Download a binary file from the remote CAS.
   * Gets a file token, fetches a presigned download URL, and downloads the bytes.
   */
  async downloadFile(vpath: string, meta: FileMetas): Promise<ArrayBuffer> {
    const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:file:${meta.id}`;

    // Get file token
    const fileToken = await this.getFileToken(s3rn, meta.hash, meta.mimetype, 0);

    // Get presigned download URL
    const response = await fetch(fileToken.baseUrl + "/download-url", {
      headers: { Authorization: `Bearer ${fileToken.token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to get download URL: ${response.status} ${await response.text()}`);
    }

    const { downloadUrl } = (await response.json()) as { downloadUrl: string };

    // Download the file
    const downloadResponse = await fetch(downloadUrl);
    if (!downloadResponse.ok) {
      throw new Error(`Failed to download file: ${downloadResponse.status}`);
    }

    return downloadResponse.arrayBuffer();
  }

  /**
   * Upload a binary file to the remote CAS.
   * Accepts a pre-computed SHA256 hash (the caller is responsible for
   * verifying that the hash differs from the current meta before calling).
   * Gets a file token, fetches a presigned upload URL, and PUTs the bytes.
   * Returns the SHA256 hash of the uploaded content.
   */
  async uploadFile(vpath: string, meta: FileMetas, content: ArrayBuffer, hash: string): Promise<string> {
    const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:file:${meta.id}`;

    // Get file token
    const fileToken = await this.getFileToken(s3rn, hash, meta.mimetype, content.byteLength);

    // Get presigned upload URL
    const response = await fetch(fileToken.baseUrl + "/upload-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${fileToken.token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to get upload URL: ${response.status} ${await response.text()}`);
    }

    const { uploadUrl } = (await response.json()) as { uploadUrl: string };

    // Upload the file
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": meta.mimetype },
      body: content,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload file: ${uploadResponse.status}`);
    }

    return hash;
  }

  /**
   * Get a FileToken from the API for binary file operations.
   * The FileToken contains a baseUrl and short-lived token for presigned URL requests.
   */
  private async getFileToken(
    s3rn: string,
    hash: string,
    contentType: string,
    contentLength: number,
  ): Promise<FileToken> {
    const decoded = decodeS3RN(s3rn);
    if (decoded.kind !== "file") {
      throw new Error(`Invalid S3RN for file: ${s3rn} (decoded kind: ${decoded.kind})`);
    }
    const entity = decoded as S3RNFile;

    const response = await fetch(`${this.config.apiUrl}/file-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authManager.getToken()}`,
        "Content-Type": "application/json",
        "Relay-Version": RELAY_VERSION,
      },
      body: JSON.stringify({
        docId: entity.fileId,
        relay: entity.relayId,
        folder: entity.folderId,
        hash,
        contentType,
        contentLength,
      }),
    });

    if (!response.ok) {
      throw new Error(`File token fetch failed: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<FileToken>;
  }

  /**
   * Compute SHA256 hash of binary content.
   * Returns the hex-encoded hash string.
   */
  computeSHA256(content: ArrayBuffer): string {
    return sha256Hex(content);
  }
}
