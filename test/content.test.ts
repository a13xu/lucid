import { describe, it, expect, beforeEach } from "vitest";
import {
  compress, decompress, invalidateContent, contentCacheStats, sha256,
} from "../src/store/content.js";

const GARBAGE = Buffer.from("definitely not zlib data");

describe("compress/decompress", () => {
  beforeEach(() => {
    invalidateContent();
  });

  it("round-trips utf-8 source", () => {
    const src = "export const π = 3.14; // ünïcode ✓\nline2\n";
    expect(decompress(compress(src))).toBe(src);
  });

  it("throws on corrupt blobs when uncached", () => {
    expect(() => decompress(GARBAGE)).toThrow();
  });

  it("serves from cache by content hash without re-inflating", () => {
    const src = "cached content";
    const blob = compress(src);
    const hash = sha256(src);
    expect(decompress(blob, hash)).toBe(src);
    // Same hash + corrupt blob: cache hit means the blob is never inflated
    expect(decompress(GARBAGE, hash)).toBe(src);
  });

  it("invalidates a single hash", () => {
    const src = "to be invalidated";
    const hash = sha256(src);
    decompress(compress(src), hash);
    invalidateContent(hash);
    expect(() => decompress(GARBAGE, hash)).toThrow();
  });

  it("invalidates everything when called without args", () => {
    decompress(compress("a"), sha256("a"));
    decompress(compress("b"), sha256("b"));
    invalidateContent();
    expect(contentCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("tracks entries and bytes in stats", () => {
    const src = "12345678";
    decompress(compress(src), sha256(src));
    const stats = contentCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(src.length);
  });

  it("refuses to cache entries larger than the cap", () => {
    const huge = "x".repeat(33 * 1024 * 1024);
    const hash = sha256("huge-marker");
    decompress(compress(huge), hash);
    expect(contentCacheStats().entries).toBe(0);
    expect(() => decompress(GARBAGE, hash)).toThrow();
  });

  it("evicts oldest entries once over the byte cap", () => {
    const eight = 8 * 1024 * 1024;
    for (const label of ["a", "b", "c", "d", "e"]) {
      const text = label.repeat(eight);
      decompress(compress(text), sha256(label));
    }
    const stats = contentCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(stats.entries).toBe(4);
    // "a" was evicted; "e" is still cached
    expect(() => decompress(GARBAGE, sha256("a"))).toThrow();
    expect(decompress(GARBAGE, sha256("e"))).toBe("e".repeat(eight));
  });
});

describe("sha256", () => {
  it("is deterministic and hex-encoded", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });
});
