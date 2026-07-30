// Smart context assembly — BM25 candidate-set + RRF fusion (BM25/Qdrant/TF-IDF)
// + recency/reward priors + AST skeleton pruning.
// Falls back gracefully: hybrid → TF-IDF full scan (empty FTS) → recency-only

import { decompress } from "../store/content.js";
import { rankByRelevance } from "./tfidf.js";
import { fuseRanks, toFtsQuery } from "./fuse.js";
import { extractSkeleton, renderSkeleton } from "../indexer/ast.js";
import { searchQdrant } from "./qdrant.js";
import type { Statements, FileContentRow } from "../database.js";
import type { ResolvedConfig } from "../config.js";
import { getQdrantConfig } from "../config.js";
import { getFileRewardsMap } from "../memory/experience.js";
import { tryCompressTextSemantic } from "../compression/semantic.js";

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
  strategy: "qdrant" | "tfidf" | "recent" | "hybrid";
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

  type FileRow = Pick<FileContentRow, "filepath" | "content" | "language" | "content_hash" | "indexed_at">;

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - recentHours * 3600;

  // Experience-based rewards (memoized 30s) — used both as candidate source and prior
  const fileRewards = getFileRewardsMap(stmts);

  // ---------------------------------------------------------------------------
  // Candidate selection: BM25 top-N ∪ recent window ∪ rewarded paths.
  // Full scan only when the FTS index is empty (pre-backfill DB) or the query
  // has no indexable terms — then TF-IDF over everything, as before.
  // ---------------------------------------------------------------------------

  const BM25_CANDIDATES = 120;
  const ftsQuery = toFtsQuery(query);
  let bm25Order: string[] = [];
  let rows: FileRow[];
  let usedCandidateSet = false;

  const fetchByPaths = (paths: string[]): FileRow[] =>
    paths.length > 0 ? (stmts.getFilesByPaths.all(JSON.stringify(paths)) as FileRow[]) : [];

  if (opts.recentOnly) {
    rows = fetchByPaths(stmts.getRecentFiles.all(cutoffSec).map((r) => r.filepath));
  } else {
    let ftsPopulated = false;
    if (ftsQuery) {
      try {
        bm25Order = stmts.searchFileFtsBM25.all(ftsQuery, BM25_CANDIDATES).map((r) => r.filepath);
        ftsPopulated = bm25Order.length > 0 || (stmts.countFileFts.get()?.c ?? 0) > 0;
      } catch { /* malformed MATCH — fall through to full scan */ }
    }
    if (ftsPopulated) {
      const candidatePaths = new Set<string>(bm25Order);
      for (const r of stmts.getRecentFiles.all(cutoffSec)) candidatePaths.add(r.filepath);
      for (const fp of fileRewards.keys()) candidatePaths.add(fp);
      rows = fetchByPaths([...candidatePaths]);
      usedCandidateSet = true;
    } else {
      rows = stmts.getAllFiles.all() as FileRow[];
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { files: [], totalTokens: 0, strategy: opts.recentOnly ? "recent" : "tfidf", truncated: false, skippedFiles: 0 };
  }

  // Apply whitelist dirs filter
  const dirs = opts.dirs ?? cfg.whitelistDirs;
  const candidates = dirs && dirs.length > 0
    ? rows.filter((r) => dirs.some((d) => r.filepath.replace(/\\/g, "/").includes(d)))
    : rows;

  const recentSet = new Set(
    candidates.filter((r) => (r.indexed_at ?? 0) >= cutoffSec).map((r) => r.filepath)
  );

  if (candidates.length === 0) {
    return { files: [], totalTokens: 0, strategy: opts.recentOnly ? "recent" : "tfidf", truncated: false, skippedFiles: rows.length };
  }

  // Decompress candidates (bounded by candidate-set size; LRU-cached by hash)
  const decompressed = candidates.map((r) => ({
    filepath: r.filepath,
    language: r.language,
    indexedAt: r.indexed_at ?? 0,
    hash: r.content_hash,
    text: decompress(r.content, r.content_hash),
  }));

  // ---------------------------------------------------------------------------
  // Ranking: RRF fusion of BM25 + Qdrant + TF-IDF, with recency/reward priors
  // ---------------------------------------------------------------------------

  let strategy: ContextResult["strategy"] = opts.recentOnly ? "recent" : usedCandidateSet ? "hybrid" : "tfidf";

  const tfidfOrder = rankByRelevance(query, decompressed)
    .filter((s) => s.score > 0)
    .map((s) => s.filepath);

  let qdrantOrder: string[] = [];
  const qdrantCfg = getQdrantConfig(cfg);
  if (qdrantCfg && !opts.recentOnly) {
    try {
      const chunks = await searchQdrant(query, topK * 3, qdrantCfg);
      const seen = new Set<string>();
      for (const c of chunks) {
        if (!seen.has(c.filepath)) { seen.add(c.filepath); qdrantOrder.push(c.filepath); }
      }
      if (qdrantOrder.length > 0) strategy = "qdrant";
    } catch { /* Qdrant unreachable — remaining retrievers still vote */ }
  }

  const maxReward = fileRewards.size > 0 ? Math.max(...fileRewards.values()) : 0;
  const priors = new Map<string, number>();
  for (const d of decompressed) {
    let p = recentSet.has(d.filepath) ? 0.5 : 0;
    if (maxReward > 0) p += ((fileRewards.get(d.filepath) ?? 0) / maxReward) * 0.5;
    if (p > 0) priors.set(d.filepath, p);
  }

  const scores = fuseRanks([bm25Order, qdrantOrder, tfidfOrder], priors);
  const ranked = [...decompressed].sort(
    (a, b) => (scores.get(b.filepath) ?? 0) - (scores.get(a.filepath) ?? 0)
  );

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

    // Semantic compression — applied after skeleton/full decision, before token counting
    if (cfg.semanticCompression?.enabled) {
      content = await tryCompressTextSemantic(
        content,
        cfg.semanticCompression.ratio ?? 0.5,
        cfg.semanticCompression.minLength ?? 300
      );
      reason += " +compressed";
    }

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

