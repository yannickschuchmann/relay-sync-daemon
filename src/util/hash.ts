/**
 * Compute a SHA-256 hash of the given data and return it as a hex string.
 * Uses Bun's native CryptoHasher for performance.
 */
export function sha256Hex(data: Uint8Array | ArrayBuffer | string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  if (data instanceof ArrayBuffer) {
    hasher.update(new Uint8Array(data));
  } else {
    hasher.update(data);
  }
  return hasher.digest("hex");
}

/**
 * Compute a SHA-256 hash of a file on disk, streaming to avoid loading
 * the entire file into memory at once (useful for large binary files).
 */
export async function sha256File(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = file.stream();

  for await (const chunk of stream) {
    hasher.update(chunk);
  }

  return hasher.digest("hex");
}
