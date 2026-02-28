import { z } from "zod";
import type { Statements } from "../database.js";
import { assembleContext } from "../retrieval/context.js";
import { loadConfig } from "../config.js";
import { decompress } from "../store/content.js";
import { computeDiff } from "../retrieval/context.js";

// ---------------------------------------------------------------------------
// get_context — smart token-efficient context retrieval
// ---------------------------------------------------------------------------

export const GetContextSchema = z.object({
  query: z.string().min(1).describe("What you are working on or searching for"),
  maxTokens: z.number().int().min(100).max(32000).optional()
    .describe("Total token budget (default from lucid.config.json, typically 4000)"),
  dirs: z.array(z.string()).optional()
    .describe("Whitelist: only return files from these directories (e.g. [\"src\", \"backend\"])"),
  recentOnly: z.boolean().optional()
    .describe("Only return files modified within recentWindowHours"),
  recentHours: z.number().optional()
    .describe("Override recentWindowHours for this call"),
  skeletonOnly: z.boolean().optional()
    .describe("Always show skeleton (signatures only) even for small files"),
  topK: z.number().int().min(1).max(50).optional()
    .describe("Max files to consider (Qdrant: top-k chunks)"),
});

export async function handleGetContext(
  stmts: Statements,
  args: z.infer<typeof GetContextSchema>
): Promise<string> {
  const cfg = loadConfig();

  const result = await assembleContext(args.query, stmts, cfg, {
    maxTokens: args.maxTokens,
    dirs: args.dirs,
    recentOnly: args.recentOnly,
    recentHours: args.recentHours,
    skeletonOnly: args.skeletonOnly,
    topK: args.topK,
  });

  if (result.files.length === 0) {
    return [
      `⚠️  No relevant files found for: "${args.query}"`,
      `   Strategy: ${result.strategy}`,
      `   Tip: run init_project() or sync_project() first to index files`,
    ].join("\n");
  }

  const lines: string[] = [
    `// get_context: "${args.query}"`,
    `// Strategy: ${result.strategy} | ${result.files.length} files | ~${result.totalTokens} tokens`,
    result.truncated ? `// ⚠️  Truncated (${result.skippedFiles} files skipped — increase maxTokens to see more)` : "",
    "",
  ].filter((l) => l !== undefined);

  for (const f of result.files) {
    lines.push(`// ─── ${f.filepath} [${f.language}] ~${f.tokens}t (${f.reason}) ───`);
    lines.push(f.content);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// get_recent — recently modified files with diffs
// ---------------------------------------------------------------------------

export const GetRecentSchema = z.object({
  hours: z.number().positive().optional()
    .describe("Look back N hours (default 24)"),
  withDiffs: z.boolean().optional()
    .describe("Include line-level diffs (default true)"),
});

export function handleGetRecent(
  stmts: Statements,
  args: z.infer<typeof GetRecentSchema>
): string {
  const cfg = loadConfig();
  const hours = args.hours ?? cfg.recentWindowHours;
  const withDiffs = args.withDiffs ?? true;

  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

  const recentFiles = stmts.getRecentFiles.all(cutoff) as Array<{
    filepath: string;
    language: string;
    indexed_at: number;
  }>;

  if (recentFiles.length === 0) {
    return `No files modified in the last ${hours}h.\nTip: call sync_file(path) after each file change.`;
  }

  const recentDiffs = withDiffs
    ? (stmts.getRecentDiffs.all(cutoff) as Array<{
        filepath: string;
        diff_text: string;
        changed_at: number;
      }>)
    : [];

  const diffMap = new Map(recentDiffs.map((d) => [d.filepath, d]));

  const lines: string[] = [
    `// ${recentFiles.length} file(s) modified in the last ${hours}h`,
    "",
  ];

  for (const f of recentFiles) {
    const age = Math.round((Date.now() / 1000 - f.indexed_at) / 60);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
    lines.push(`// ─── ${f.filepath} [${f.language}] (${ageStr}) ───`);

    const diff = diffMap.get(f.filepath);
    if (diff) {
      lines.push(diff.diff_text);
    } else {
      // New file — show first ~20 lines
      const row = stmts.getFileByPath.get(f.filepath);
      if (row) {
        const src = decompress(row.content).split("\n").slice(0, 20).join("\n");
        lines.push(src);
        if (row.original_size > src.length) lines.push("… [new file, showing first 20 lines]");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
