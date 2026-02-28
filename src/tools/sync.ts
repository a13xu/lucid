import { z } from "zod";
import { resolve, extname } from "path";
import { existsSync } from "fs";
import type { Statements } from "../database.js";
import { indexFile, upsertFileIndex } from "../indexer/file.js";
import { indexProject, type IndexResult } from "../indexer/project.js";

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);

// ---------------------------------------------------------------------------
// sync_file — indexează un singur fișier modificat
// ---------------------------------------------------------------------------

export const SyncFileSchema = z.object({
  path: z.string().min(1),
});

export function handleSyncFile(stmts: Statements, args: z.infer<typeof SyncFileSchema>): string {
  const filepath = resolve(args.path);

  if (!existsSync(filepath)) {
    return `File not found: ${filepath}`;
  }

  if (!SUPPORTED_EXTS.has(extname(filepath).toLowerCase())) {
    return `Unsupported file type: ${extname(filepath)}. Supported: ${[...SUPPORTED_EXTS].join(", ")}`;
  }

  const index = indexFile(filepath);
  if (!index) {
    return `Could not read file: ${filepath}`;
  }

  const observations = upsertFileIndex(index, stmts);

  if (observations.length === 0) {
    return `No indexable content in: ${filepath}`;
  }

  const lines = [
    `✅ Synced: ${filepath}`,
    `   exports: ${index.exports.join(", ") || "none"}`,
  ];
  if (index.description) lines.push(`   description: ${index.description}`);
  if (index.todos.length > 0) lines.push(`   TODOs: ${index.todos.length} open`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// sync_project — re-indexează întregul proiect incremental
// ---------------------------------------------------------------------------

export const SyncProjectSchema = z.object({
  directory: z.string().optional(),
});

export function handleSyncProject(stmts: Statements, args: z.infer<typeof SyncProjectSchema>): string {
  const dir = resolve(args.directory ?? process.cwd());
  const results: IndexResult[] = indexProject(dir, stmts);

  if (results.length === 0) {
    return `No changes indexed in: ${dir}`;
  }

  const total = results.reduce((sum, r) => sum + r.observations, 0);
  return [
    `✅ Project re-synced: ${dir}`,
    `   ${results.length} source(s) updated, ${total} observations`,
  ].join("\n");
}
