/**
 * Truncate Guard — prevents data-loss writes (file emptied, drastically shrunk)
 * and detects truncate cascades (≥N truncate attempts within a short window),
 * which signal a runaway loop in automode.
 *
 * Two layers:
 *   1) Per-write check: empty content over non-empty file, or new size < 30% prev.
 *   2) Cascade lock: ≥2 blocked truncates within 60s blocks ALL further Write/Edit
 *      until the user clears the lock (clear_truncate_lock tool or env override).
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { Statements } from "../database.js";
import { compress, sha256 } from "../store/content.js";

// ---------------------------------------------------------------------------
// Tunables (kept local — no config knob until requested)
// ---------------------------------------------------------------------------

/** New content must keep ≥ this fraction of previous size, else flagged. */
const MIN_KEEP_RATIO = 0.30;

/** Files smaller than this are exempt — too small for ratio to be meaningful. */
const SMALL_FILE_BYTES = 80;

/** Cascade window: how far back we look for blocked truncate events. */
const CASCADE_WINDOW_SECONDS = 60;

/** Number of blocked truncates within the window that triggers a hard lock. */
const CASCADE_THRESHOLD = 2;

/** Backups kept per file (last N). */
const BACKUP_RETENTION = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TruncateRule =
  | "EMPTY_OVERWRITE"   // new content empty over non-empty file
  | "WHITESPACE_ONLY"   // new content is whitespace-only over non-empty file
  | "MAJOR_SHRINK"      // new size below MIN_KEEP_RATIO of previous
  | "CASCADE_LOCK";     // global lock held due to recent cascade

export interface TruncateAssessment {
  blocked: boolean;
  rule?: TruncateRule;
  prevSize: number;
  newSize: number;
  shrinkRatio: number;
  reason?: string;
  /** True when CASCADE_LOCK is the active reason. */
  cascade: boolean;
  /** Number of blocked truncates inside the cascade window. */
  cascadeCount: number;
}

// ---------------------------------------------------------------------------
// Cascade detection
// ---------------------------------------------------------------------------

export function isCascadeBlocked(stmts: Statements): { blocked: boolean; count: number } {
  if (process.env["LUCID_TRUNCATE_OVERRIDE"] === "1") {
    return { blocked: false, count: 0 };
  }
  const since = Math.floor(Date.now() / 1000) - CASCADE_WINDOW_SECONDS;
  const row = stmts.countRecentTruncates.get(since);
  const count = row?.count ?? 0;
  return { blocked: count >= CASCADE_THRESHOLD, count };
}

// ---------------------------------------------------------------------------
// Per-write assessment
// ---------------------------------------------------------------------------

/**
 * Assess whether writing `newContent` to `path` is a destructive truncate.
 * Pure function — does NOT mutate state. Caller decides whether to record.
 */
export function assessTruncate(
  path: string,
  newContent: string | null,
  stmts: Statements,
): TruncateAssessment {
  const cascade = isCascadeBlocked(stmts);
  const absPath = resolve(path);

  // Resolve previous size: filesystem first (source of truth), DB as fallback.
  let prevSize = 0;
  if (existsSync(absPath)) {
    try { prevSize = statSync(absPath).size; } catch { /* ignore */ }
  }
  if (prevSize === 0) {
    const dbRow = stmts.getFileByPath.get(absPath);
    if (dbRow) prevSize = dbRow.original_size;
  }

  const newSize = newContent === null
    ? -1   // unknown — only cascade lock can apply
    : Buffer.byteLength(newContent, "utf-8");

  const ratio = prevSize > 0 && newSize >= 0 ? newSize / prevSize : 1;

  // Cascade lock takes precedence — even non-truncating writes are blocked.
  if (cascade.blocked) {
    return {
      blocked: true,
      rule: "CASCADE_LOCK",
      prevSize, newSize, shrinkRatio: ratio,
      cascade: true,
      cascadeCount: cascade.count,
      reason:
        `Cascade lock active: ${cascade.count} truncate attempts within ${CASCADE_WINDOW_SECONDS}s. ` +
        `Run "lucid guard clear" or set LUCID_TRUNCATE_OVERRIDE=1 to release.`,
    };
  }

  // Nothing to compare against — first-time write, allow.
  if (prevSize === 0 || prevSize <= SMALL_FILE_BYTES || newSize < 0) {
    return { blocked: false, prevSize, newSize, shrinkRatio: ratio, cascade: false, cascadeCount: cascade.count };
  }

  if (newSize === 0) {
    return rule("EMPTY_OVERWRITE", prevSize, newSize, ratio, cascade.count,
      `Refusing to overwrite ${prevSize}B file with empty content.`);
  }

  if (newContent !== null && newContent.trim().length === 0) {
    return rule("WHITESPACE_ONLY", prevSize, newSize, ratio, cascade.count,
      `Refusing to overwrite ${prevSize}B file with whitespace-only content (${newSize}B).`);
  }

  if (ratio < MIN_KEEP_RATIO) {
    return rule("MAJOR_SHRINK", prevSize, newSize, ratio, cascade.count,
      `New content keeps only ${Math.round(ratio * 100)}% of previous size ` +
      `(${newSize}B vs ${prevSize}B). Threshold: ${Math.round(MIN_KEEP_RATIO * 100)}%.`);
  }

  return { blocked: false, prevSize, newSize, shrinkRatio: ratio, cascade: false, cascadeCount: cascade.count };
}

function rule(
  r: TruncateRule, prev: number, next: number, ratio: number, cascadeCount: number, reason: string,
): TruncateAssessment {
  return { blocked: true, rule: r, prevSize: prev, newSize: next,
           shrinkRatio: ratio, cascade: false, cascadeCount, reason };
}

/** Persist a truncate event so cascade detection can see it on the next call. */
export function recordTruncateEvent(
  stmts: Statements, path: string, prevSize: number, newSize: number, blocked: boolean,
): void {
  const ratio = prevSize > 0 ? Math.max(0, newSize) / prevSize : 1;
  stmts.insertTruncateEvent.run(resolve(path), prevSize, Math.max(0, newSize), ratio, blocked ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Backup operations
// ---------------------------------------------------------------------------

export interface BackupResult {
  saved: boolean;
  reason: string;
  size?: number;
  hash?: string;
}

/**
 * Snapshot the current on-disk file content into file_backups, then GC older
 * versions beyond BACKUP_RETENTION. No-op if the file does not exist or is
 * identical to the most recent backup.
 */
export function backupFile(
  stmts: Statements, path: string, snapshotReason = "manual",
): BackupResult {
  const absPath = resolve(path);
  if (!existsSync(absPath)) return { saved: false, reason: `File not found: ${absPath}` };

  let source: string;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (e) {
    return { saved: false, reason: `Could not read file: ${(e as Error).message}` };
  }

  const hash = sha256(source);
  const latest = stmts.getLatestBackup.get(absPath);
  if (latest && latest.content_hash === hash) {
    return { saved: false, reason: "Identical to latest backup — skipped", hash, size: latest.original_size };
  }

  const compressed = compress(source);
  stmts.insertBackup.run(
    absPath,
    compressed,
    hash,
    Buffer.byteLength(source, "utf-8"),
    compressed.length,
    snapshotReason,
  );

  // Garbage-collect older versions beyond retention.
  stmts.deleteOldBackups.run(absPath, absPath, BACKUP_RETENTION);

  return { saved: true, reason: `Snapshot stored (${snapshotReason})`, hash, size: Buffer.byteLength(source, "utf-8") };
}

export const TUNABLES = {
  MIN_KEEP_RATIO,
  SMALL_FILE_BYTES,
  CASCADE_WINDOW_SECONDS,
  CASCADE_THRESHOLD,
  BACKUP_RETENTION,
} as const;
