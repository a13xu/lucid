import { deflateSync, inflateSync } from "zlib";
import { createHash } from "crypto";

// Level 6 ≈ 2.5x faster than 9 for ~1-2% larger blobs on source code.
const DEFLATE_LEVEL = 6;

export function compress(source: string): Buffer {
  return deflateSync(Buffer.from(source, "utf-8"), { level: DEFLATE_LEVEL });
}

// ---------------------------------------------------------------------------
// LRU cache of decompressed text, keyed by content_hash (self-invalidating:
// changed content → new hash). Map preserves insertion order → oldest first.
// ---------------------------------------------------------------------------

const CACHE_MAX_BYTES = 32 * 1024 * 1024;

const cache = new Map<string, string>();
let cacheBytes = 0;

function cachePut(hash: string, text: string): void {
  const size = text.length;
  if (size > CACHE_MAX_BYTES) return;
  const prev = cache.get(hash);
  if (prev !== undefined) {
    cache.delete(hash);
    cacheBytes -= prev.length;
  }
  cache.set(hash, text);
  cacheBytes += size;
  while (cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value as string;
    cacheBytes -= cache.get(oldest)!.length;
    cache.delete(oldest);
  }
}

export function decompress(blob: Buffer, contentHash?: string): string {
  if (contentHash !== undefined) {
    const hit = cache.get(contentHash);
    if (hit !== undefined) {
      cache.delete(contentHash);
      cache.set(contentHash, hit);
      return hit;
    }
  }
  const text = inflateSync(blob).toString("utf-8");
  if (contentHash !== undefined) cachePut(contentHash, text);
  return text;
}

export function invalidateContent(contentHash?: string): void {
  if (contentHash === undefined) {
    cache.clear();
    cacheBytes = 0;
    return;
  }
  const prev = cache.get(contentHash);
  if (prev !== undefined) {
    cache.delete(contentHash);
    cacheBytes -= prev.length;
  }
}

export function contentCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cacheBytes };
}

export function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
