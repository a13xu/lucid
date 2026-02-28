import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface LucidConfig {
  /** Only index/return files from these directories (e.g. ["src", "lib", "backend"]) */
  whitelistDirs?: string[];
  /** Additional dirs to skip (merged with built-in SKIP_DIRS) */
  blacklistDirs?: string[];
  /** Max estimated tokens to return per file in get_context (default 400) */
  maxTokensPerFile?: number;
  /** Total token budget for get_context response (default 4000) */
  maxContextTokens?: number;
  /** "Recently touched" = modified within N hours (default 24) */
  recentWindowHours?: number;
  /** Optional Qdrant vector search (falls back to TF-IDF if not configured) */
  qdrant?: {
    url: string;           // e.g. "http://localhost:6333"
    apiKey?: string;
    collection?: string;   // default: "lucid"
    /** Embedding endpoint — must be OpenAI-compatible */
    embeddingUrl?: string; // default: "https://api.openai.com/v1/embeddings"
    embeddingApiKey?: string; // falls back to OPENAI_API_KEY env var
    embeddingModel?: string;  // default: "text-embedding-3-small"
    vectorDim?: number;       // default: 1536
  };
}

export interface Defaults {
  maxTokensPerFile: number;
  maxContextTokens: number;
  recentWindowHours: number;
}

export const DEFAULTS: Defaults = {
  maxTokensPerFile: 400,
  maxContextTokens: 4000,
  recentWindowHours: 24,
};

export type ResolvedConfig = Defaults & LucidConfig;

let _cached: ResolvedConfig | null = null;

export function loadConfig(projectDir?: string): ResolvedConfig {
  if (_cached) return _cached;

  const dirs = [projectDir, process.cwd()].filter(Boolean) as string[];
  for (const dir of dirs) {
    const cfgPath = join(dir, "lucid.config.json");
    if (existsSync(cfgPath)) {
      try {
        const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as LucidConfig;
        _cached = { ...DEFAULTS, ...raw } as ResolvedConfig;
        return _cached;
      } catch { /* malformed — skip */ }
    }
  }

  _cached = { ...DEFAULTS };
  return _cached;
}

/** Qdrant config from lucid.config.json or env vars */
export function getQdrantConfig(cfg: ResolvedConfig): ResolvedConfig["qdrant"] | null {
  // Env vars override config file
  const url = process.env["QDRANT_URL"] ?? cfg.qdrant?.url;
  if (!url) return null;

  return {
    url,
    apiKey: process.env["QDRANT_API_KEY"] ?? cfg.qdrant?.apiKey,
    collection: process.env["QDRANT_COLLECTION"] ?? cfg.qdrant?.collection ?? "lucid",
    embeddingUrl: process.env["EMBEDDING_URL"] ?? cfg.qdrant?.embeddingUrl ?? "https://api.openai.com/v1/embeddings",
    embeddingApiKey: process.env["EMBEDDING_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? cfg.qdrant?.embeddingApiKey,
    embeddingModel: process.env["EMBEDDING_MODEL"] ?? cfg.qdrant?.embeddingModel ?? "text-embedding-3-small",
    vectorDim: cfg.qdrant?.vectorDim ?? 1536,
  };
}

export function resetConfigCache(): void {
  _cached = null;
}
