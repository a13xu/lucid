import { deflateSync, inflateSync } from "zlib";
import { createHash } from "crypto";

export function compress(source: string): Buffer {
  return deflateSync(Buffer.from(source, "utf-8"), { level: 9 });
}

export function decompress(blob: Buffer): string {
  return inflateSync(blob).toString("utf-8");
}

export function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
