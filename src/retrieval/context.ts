// Smart context assembly — TF-IDF + recency boost + AST skeleton pruning
// Falls back gracefully: Qdrant → TF-IDF → recency-only

import { decompress } from "../store/content.js";
import { rankByRelevance } from "./tfidf.js";
import { extractSkeleton, renderSkeleton } from "../indexer/ast.js";
import { searchQdrant } from "./qdrant.js";
import type { Statements, FileContentRow } from "../database.js";
import type { ResolvedConfig } from "../config.js";
import { getQdrantConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Token estimation (1 token ≈ 4 chars is the standard heuristic)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Relevant fragment extraction (lines around query matches)
// ---------------------------------------------------------------------------

export function extractFragments(source: string, query: string, contextLines = 3): string {
  const lines = source.split("\n");
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const hitLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        hitLines.add(j);
      }
    }
  }

  if (hitLines.size === 0) return "";

  const sorted = [...hitLines].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -2;
  for (const n of sorted) {
    if (n > prev + 1) out.push("…");
    out.push(`${n + 1}: ${lines[n]}`);
    prev = n;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Simple line-level diff (no external deps)
// ---------------------------------------------------------------------------

export function computeDiff(prev: string, curr: string, maxChanges = 40): string {
  const pLines = prev.split("\n");
  const cLines = curr.split("\n");
  const out: string[] = [];
  let changes = 0;

  const maxLen = Math.max(pLines.length, cLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (changes >= maxChanges) {
      out.push(`[… +${Math.abs(cLines.length - pLines.length)} more line changes, truncated]`);
      break;
    }
    const p = pLines[i];
    const c = cLines[i];
    if (p === c) continue;
    if (p === undefined) { out.push(`+${i + 1}: ${c}`); }
    else if (c === undefined) { out.push(`-${i + 1}: ${p}`); }
    else { out.push(`-${i + 1}: ${p}`); out.push(`+${i + 1}: ${c}`); }
    changes++;
  }

  return out.length > 0 ? out.join("\n") : "[no line changes]";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextFile {
  filepath: string;
  language: string;
  tokens: number;
  content: string;
  reason: string;
}

export interface ContextResult {
  files: ContextFile[];
  totalTokens: number;
  strategy: "qdrant" | "tfidf" | "recent";
  truncated: boolean;
  skippedFiles: number;
}

export interface ContextOptions {
  maxTokens?: number;
  maxTokensPerFile?: number;
  dirs?: string[];        // whitelist dirs filter
  recentOnly?: boolean;   // only return recently modified files
  recentHours?: number;
  skeletonOnly?: boolean; // always show skeleton (never full file)
  topK?: number;          // for Qdrant: how many chunks to retrieve
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function assembleContext(
  query: string,
  stmts: Statements,
  cfg: ResolvedConfig,
  opts: ContextOptions = {}
): Promise<ContextResult> {
  const maxTokens = opts.maxTokens ?? cfg.maxContextTokens;
  const maxPerFile = opts.maxTokensPerFile ?? cfg.maxTokensPerFile;
  const recentHours = opts.recentHours ?? cfg.recentWindowHours;
  const topK = opts.topK ?? 10;

  // Fetch all indexed files (filepath, content blob, language, indexed_at)
  type FileRow = Pick<FileContentRow, "filepath" | "content" | "language" | "content_hash" | "indexed_at">;
  const allRows = stmts.getAllFiles.all() as FileRow[];

  if (!Array.isArray(allRows) || allRows.length === 0) {
    return { files: [], totalTokens: 0, strategy: "tfidf", truncated: false, skippedFiles: 0 };
  }

  // Apply whitelist dirs filter
  const dirs = opts.dirs ?? cfg.whitelistDirs;
  const filtered = dirs && dirs.length > 0
    ? allRows.filter((r) => dirs.some((d) => r.filepath.replace(/\\/g, "/").includes(d)))
    : allRows;

  // Recency cutoff
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - recentHours * 3600;

  const recentSet = new Set(
    filtered.filter((r) => (r.indexed_at ?? 0) >= cutoffSec).map((r) => r.filepath)
  );

  // If recentOnly, skip files outside the window
  const candidates = opts.recentOnly
    ? filtered.filter((r) => recentSet.has(r.filepath))
    : filtered;

  if (candidates.length === 0) {
    return { files: [], totalTokens: 0, strategy: opts.recentOnly ? "recent" : "tfidf", truncated: false, skippedFiles: filtered.length };
  }

  // Decompress all candidates
  const decompressed = candidates.map((r) => ({
    filepath: r.filepath,
    language: r.language,
    indexedAt: r.indexed_at ?? 0,
    text: decompress(r.content),
  }));

  // ---------------------------------------------------------------------------
  // Ranking strategy
  // ---------------------------------------------------------------------------

  let strategy: ContextResult["strategy"] = "tfidf";
  let ranked: typeof decompressed;

  const qdrantCfg = getQdrantConfig(cfg);

  if (qdrantCfg && !opts.recentOnly) {
    // Try Qdrant first
    try {
      const chunks = await searchQdrant(query, topK * 3, qdrantCfg);
      if (chunks.length > 0) {
        strategy = "qdrant";
        // Deduplicate by filepath, preserve order
        const seen = new Set<string>();
        const qdrantOrder: string[] = [];
        for (const c of chunks) {
          if (!seen.has(c.filepath)) { seen.add(c.filepath); qdrantOrder.push(c.filepath); }
        }
        // Place Qdrant matches first, then remaining by TF-IDF
        const tfidfRanked = rankByRelevance(query, decompressed);
        const tfidfOrder = tfidfRanked.map((s) => s.filepath).filter((fp) => !seen.has(fp));
        const orderedFps = [...qdrantOrder, ...tfidfOrder];
        const fpToDoc = new Map(decompressed.map((d) => [d.filepath, d]));
        ranked = orderedFps.map((fp) => fpToDoc.get(fp)!).filter(Boolean);
      } else {
        ranked = rankAndBoost(query, decompressed, recentSet);
      }
    } catch {
      // Qdrant unreachable — fall back to TF-IDF
      ranked = rankAndBoost(query, decompressed, recentSet);
    }
  } else {
    ranked = rankAndBoost(query, decompressed, recentSet);
    if (opts.recentOnly) strategy = "recent";
  }

  // ---------------------------------------------------------------------------
  // Assemble context with token budget
  // ---------------------------------------------------------------------------

  const result: ContextFile[] = [];
  let totalTokens = 0;
  let truncated = false;
  let skippedFiles = 0;

  for (const file of ranked) {
    if (totalTokens >= maxTokens) { truncated = true; break; }

    const remaining = maxTokens - totalTokens;
    const fullTokens = estimateTokens(file.text);
    const isRecent = recentSet.has(file.filepath);

    let content: string;
    let reason: string;

    if (opts.skeletonOnly || fullTokens > maxPerFile) {
      const sk = extractSkeleton(file.text, file.language);
      const skText = renderSkeleton(sk, file.filepath);
      const fragments = query ? extractFragments(file.text, query) : "";
      content = fragments
        ? `${skText}\n\n// — relevant fragments —\n${fragments}`
        : skText;
      reason = opts.skeletonOnly ? "skeleton" : `skeleton (${fullTokens} tokens > limit ${maxPerFile})`;
    } else {
      content = file.text;
      reason = "full";
    }

    if (isRecent) reason += " +recent";

    const contentTokens = estimateTokens(content);
    if (contentTokens < 10) { skippedFiles++; continue; }

    // Truncate to remaining budget
    const usedTokens = Math.min(contentTokens, remaining);
    const finalContent = usedTokens < contentTokens
      ? content.slice(0, usedTokens * 4) + "\n… [truncated]"
      : content;

    result.push({ filepath: file.filepath, language: file.language, tokens: usedTokens, content: finalContent, reason });
    totalTokens += usedTokens;
  }

  skippedFiles += ranked.length - result.length - (truncated ? 0 : 0);

  return { files: result, totalTokens, strategy, truncated, skippedFiles };
}

// ---------------------------------------------------------------------------
// TF-IDF + recency boost ranking
// ---------------------------------------------------------------------------

function rankAndBoost<T extends { filepath: string; text: string; indexedAt: number }>(
  query: string,
  docs: T[],
  recentSet: Set<string>
): T[] {
  const scored = rankByRelevance(query, docs);
  const scoreMap = new Map(scored.map((s) => [s.filepath, s.score]));

  return [...docs].sort((a, b) => {
    const sA = (scoreMap.get(a.filepath) ?? 0) + (recentSet.has(a.filepath) ? 0.3 : 0);
    const sB = (scoreMap.get(b.filepath) ?? 0) + (recentSet.has(b.filepath) ? 0.3 : 0);
    return sB - sA;
  });
}
