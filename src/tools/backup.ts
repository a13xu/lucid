import { z } from "zod";
import { resolve } from "path";
import { writeFileSync } from "fs";
import type { Statements } from "../database.js";
import { decompress } from "../store/content.js";
import {
  assessTruncate,
  backupFile,
  recordTruncateEvent,
  TUNABLES,
} from "../guardian/truncate-guard.js";

// ---------------------------------------------------------------------------
// backup_file
// ---------------------------------------------------------------------------

export const BackupFileSchema = z.object({
  path:   z.string().min(1).describe("File to snapshot"),
  reason: z.string().optional().describe("Why this snapshot was taken (logged)"),
});

export function handleBackupFile(stmts: Statements, args: z.infer<typeof BackupFileSchema>): string {
  const result = backupFile(stmts, args.path, args.reason ?? "manual");
  const absPath = resolve(args.path);
  const total = stmts.countBackups.get(absPath)?.count ?? 0;

  if (!result.saved) return `⏭️  ${result.reason} (${absPath})`;
  return [
    `📸 Backup created: ${absPath}`,
    `   size: ${result.size}B  hash: ${result.hash?.slice(0, 12)}…`,
    `   versions retained: ${Math.min(total, TUNABLES.BACKUP_RETENTION)}/${TUNABLES.BACKUP_RETENTION}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// restore_file
// ---------------------------------------------------------------------------

export const RestoreFileSchema = z.object({
  path:       z.string().min(1).describe("File to restore"),
  version:    z.number().int().positive().optional()
              .describe("1 = latest backup, 2 = previous, etc. Default: 1"),
  backup_id:  z.number().int().positive().optional()
              .describe("Specific backup row id (overrides version)"),
  dry_run:    z.boolean().optional().describe("Show what would be restored without writing"),
});

export function handleRestoreFile(stmts: Statements, args: z.infer<typeof RestoreFileSchema>): string {
  const absPath = resolve(args.path);

  if (args.backup_id !== undefined) {
    const row = stmts.getBackupById.get(args.backup_id);
    if (!row) return `❌ Backup id=${args.backup_id} not found`;
    if (row.filepath !== absPath) {
      return `❌ Backup id=${args.backup_id} belongs to ${row.filepath}, not ${absPath}`;
    }
    return doRestore(absPath, row.content, row.created_at, row.original_size, args.dry_run === true);
  }

  const all = stmts.getBackupsByPath.all(absPath);
  if (all.length === 0) return `❌ No backups found for: ${absPath}`;

  const idx = (args.version ?? 1) - 1;
  if (idx < 0 || idx >= all.length) {
    return `❌ Version ${args.version} out of range (have ${all.length} backups for this file)`;
  }
  const row = all[idx]!;
  return doRestore(absPath, row.content, row.created_at, row.original_size, args.dry_run === true);
}

function doRestore(
  absPath: string, blob: Buffer, createdAt: number, originalSize: number, dryRun: boolean,
): string {
  const content = decompress(blob);
  const ts = new Date(createdAt * 1000).toISOString();

  if (dryRun) {
    return [
      `🔍 DRY RUN — would restore ${absPath}`,
      `   from snapshot at ${ts}`,
      `   size: ${originalSize}B  (${content.split("\n").length} lines)`,
    ].join("\n");
  }

  writeFileSync(absPath, content, "utf-8");
  return [
    `♻️  Restored: ${absPath}`,
    `   from snapshot at ${ts}`,
    `   size: ${originalSize}B`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// check_truncate_risk
// ---------------------------------------------------------------------------

export const CheckTruncateRiskSchema = z.object({
  path:        z.string().min(1).describe("File path the write would target"),
  new_content: z.string().optional()
               .describe("Proposed new content. Omit to query cascade-lock status only."),
  new_size:    z.number().int().nonnegative().optional()
               .describe("Proposed new size in bytes (alternative to new_content)"),
  record:      z.boolean().optional()
               .describe("If true, log this as a truncate event (used by hook). Default: false"),
});

export function handleCheckTruncateRisk(
  stmts: Statements, args: z.infer<typeof CheckTruncateRiskSchema>,
): string {
  const probeContent = args.new_content
    ?? (args.new_size !== undefined ? " ".repeat(args.new_size) : null);

  const verdict = assessTruncate(args.path, probeContent, stmts);

  if (args.record === true && verdict.blocked) {
    recordTruncateEvent(stmts, args.path, verdict.prevSize, verdict.newSize, true);
  }

  if (!verdict.blocked) {
    return [
      `✅ Safe write: ${resolve(args.path)}`,
      `   prev: ${verdict.prevSize}B → new: ${verdict.newSize >= 0 ? verdict.newSize + "B" : "?"} ` +
      `(keeps ${Math.round(verdict.shrinkRatio * 100)}%)`,
    ].join("\n");
  }

  return [
    `🛑 BLOCK [${verdict.rule}]: ${resolve(args.path)}`,
    `   ${verdict.reason}`,
    verdict.cascade
      ? `   cascade_count=${verdict.cascadeCount} within ${TUNABLES.CASCADE_WINDOW_SECONDS}s`
      : `   prev=${verdict.prevSize}B  new=${verdict.newSize}B  ratio=${verdict.shrinkRatio.toFixed(2)}`,
  ].join("\n");
}
