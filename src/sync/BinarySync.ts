import type { Config } from "../config";
import type { AuthManager } from "../auth/AuthManager";
import type { FileMetas, FileToken } from "../protocol/types";
import { RELAY_VERSION } from "../protocol/types";
import { decodeS3RN, type S3RNFile } from "../util/s3rn";
import { sha256Hex } from "../util/hash";
import { logger } from "../util/logger";


/** Timeout for metadata / token fetch operations (ms). */
const BINARY_FETCH_TIMEOUT_MS = 30_000;

/** Timeout for actual file upload/download transfers (ms). */
const BINARY_TRANSFER_TIMEOUT_MS = 300_000;

/** Maximum number of retry attempts for binary operations. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms). */
const BASE_RETRY_DELAY_MS = 1_000;

/**
 * Execute an async function with retry and exponential backoff (with jitter).
 * Retries on any error up to `MAX_RETRIES` times.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const baseDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        const delay = baseDelay + Math.random() * baseDelay;
        logger.warn(
          `${label}: attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${Math.round(delay)}ms`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Create a fetch request with an AbortController-based timeout.
 */
function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = BINARY_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Safely read response body text for error messages.
 * Returns empty string if reading the body fails.
 */
async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

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
   * Validates the SHA256 hash of the downloaded content against the expected hash
   * from metadata; throws if there is a mismatch to prevent writing corrupted data.
   */
  async downloadFile(vpath: string, meta: FileMetas): Promise<ArrayBuffer> {
    return withRetry(`downloadFile(${vpath})`, async () => {
      const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:file:${meta.id}`;

      // Get file token
      const fileToken = await this.getFileToken(s3rn, meta.hash, meta.mimetype, 0);

      // Get presigned download URL
      const response = await fetchWithTimeout(fileToken.baseUrl + "/download-url", {
        headers: { Authorization: `Bearer ${fileToken.token}` },
      });

      if (!response.ok) {
        const body = await safeResponseText(response);
        throw new Error(`Failed to get download URL: ${response.status} ${body}`);
      }

      const { downloadUrl } = (await response.json()) as { downloadUrl: string };

      // Download the file (with longer timeout for large transfers)
      const downloadResponse = await fetchWithTimeout(downloadUrl, undefined, BINARY_TRANSFER_TIMEOUT_MS);
      if (!downloadResponse.ok) {
        throw new Error(`Failed to download file: ${downloadResponse.status}`);
      }

      const content = await downloadResponse.arrayBuffer();

      // Validate SHA256 hash
      const actualHash = sha256Hex(content);
      if (actualHash !== meta.hash) {
        throw new Error(
          `Hash mismatch for ${vpath}: expected ${meta.hash}, got ${actualHash}`,
        );
      }

      return content;
    });
  }

  /**
   * Upload a binary file to the remote CAS.
   * Accepts a pre-computed SHA256 hash (the caller is responsible for
   * verifying that the hash differs from the current meta before calling).
   * Gets a file token, fetches a presigned upload URL, and PUTs the bytes.
   * Returns the SHA256 hash of the uploaded content.
   */
  async uploadFile(vpath: string, meta: FileMetas, content: ArrayBuffer, hash: string): Promise<string> {
    return withRetry(`uploadFile(${vpath})`, async () => {
      const s3rn = `s3rn:relay:relay:${this.config.relayGuid}:folder:${this.config.folderGuid}:file:${meta.id}`;

      // Get file token
      const fileToken = await this.getFileToken(s3rn, hash, meta.mimetype, content.byteLength);

      // Get presigned upload URL
      const response = await fetchWithTimeout(fileToken.baseUrl + "/upload-url", {
        method: "POST",
        headers: { Authorization: `Bearer ${fileToken.token}` },
      });

      if (!response.ok) {
        const body = await safeResponseText(response);
        throw new Error(`Failed to get upload URL: ${response.status} ${body}`);
      }

      const { uploadUrl } = (await response.json()) as { uploadUrl: string };

      // Upload the file (with longer timeout for large transfers)
      const uploadResponse = await fetchWithTimeout(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": meta.mimetype },
        body: content,
      }, BINARY_TRANSFER_TIMEOUT_MS);

      if (!uploadResponse.ok) {
        throw new Error(`Failed to upload file: ${uploadResponse.status}`);
      }

      return hash;
    });
  }

  /**
   * Get a FileToken from the API for binary file operations.
   * The FileToken contains a baseUrl and short-lived token for presigned URL requests.
   * No inner retry — the outer retry in downloadFile/uploadFile handles retries.
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

    const response = await fetchWithTimeout(`${this.config.apiUrl}/file-token`, {
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
      const body = await safeResponseText(response);
      throw new Error(`File token fetch failed: ${response.status} ${body}`);
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
