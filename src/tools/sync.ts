import { z } from "zod";
import { resolve, extname } from "path";
import { existsSync, readFileSync } from "fs";
import type { Statements } from "../database.js";
import { indexFile, upsertFileIndex } from "../indexer/file.js";
import { indexProject, type IndexResult } from "../indexer/project.js";
import { computeDiff } from "../retrieval/context.js";
import { decompress } from "../store/content.js";

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);

// ---------------------------------------------------------------------------
// sync_file
// ---------------------------------------------------------------------------

export const SyncFileSchema = z.object({
  path: z.string().min(1),
});

export function handleSyncFile(stmts: Statements, args: z.infer<typeof SyncFileSchema>): string {
  const filepath = resolve(args.path);

  if (!existsSync(filepath)) return `File not found: ${filepath}`;
  if (!SUPPORTED_EXTS.has(extname(filepath).toLowerCase())) {
    return `Unsupported file type: ${extname(filepath)}. Supported: ${[...SUPPORTED_EXTS].join(", ")}`;
  }

  const index = indexFile(filepath);
  if (!index) return `Could not read file: ${filepath}`;

  const source = readFileSync(filepath, "utf-8");

  // Capture previous content before upsert (for diff)
  const prevRow = stmts.getFileByPath.get(filepath);
  const prevSource = prevRow ? decompress(prevRow.content) : null;

  const result = upsertFileIndex(index, source, stmts);

  if (!result.stored) {
    return `⏭️  Unchanged: ${filepath} (hash match — skipped)`;
  }

  // Store diff when file changed
  if (prevRow && prevSource !== null) {
    const diff = computeDiff(prevSource, source);
    stmts.upsertDiff.run(filepath, prevRow.content_hash, diff);
  }

  const ratio = Math.round((1 - (result.savedBytes + Buffer.byteLength(source, "utf-8") - result.savedBytes) / Buffer.byteLength(source, "utf-8")) * 100);
  const saved = Math.round(result.savedBytes / 1024 * 10) / 10;

  const lines = [
    `✅ Synced: ${filepath}`,
    `   exports: ${index.exports.join(", ") || "none"}`,
    `   compressed: saved ${saved}KB`,
  ];
  if (index.description) lines.push(`   description: ${index.description}`);
  if (index.todos.length > 0) lines.push(`   TODOs: ${index.todos.length} open`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// sync_project
// ---------------------------------------------------------------------------

export const SyncProjectSchema = z.object({
  directory: z.string().optional(),
});

export function handleSyncProject(stmts: Statements, args: z.infer<typeof SyncProjectSchema>): string {
  const dir = resolve(args.directory ?? process.cwd());
  const results: IndexResult[] = indexProject(dir, stmts);

  if (results.length === 0) return `No changes indexed in: ${dir}`;

  const stats = stmts.fileStorageStats.get()!;
  const ratio = stats.total_original > 0
    ? Math.round((1 - stats.total_compressed / stats.total_original) * 100)
    : 0;

  return [
    `✅ Project re-synced: ${dir}`,
    `   ${results.length} source(s) updated`,
    `   Storage: ${Math.round(stats.total_compressed / 1024)}KB compressed / ${Math.round(stats.total_original / 1024)}KB original (${ratio}% saved)`,
  ].join("\n");
}
