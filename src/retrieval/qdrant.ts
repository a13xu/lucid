// Qdrant vector search — via direct REST API calls (no npm dependency)
// Only active when QDRANT_URL is set (via env var or lucid.config.json)
// Falls back silently to TF-IDF when unavailable

import type { ResolvedConfig } from "../config.js";

type QdrantCfg = NonNullable<ResolvedConfig["qdrant"]>;

export interface VectorChunk {
  id: number;
  filepath: string;
  chunkIndex: number;
  text: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Embedding generation (OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

async function embed(texts: string[], cfg: QdrantCfg): Promise<number[][]> {
  if (!cfg.embeddingApiKey) {
    throw new Error("No embedding API key (set OPENAI_API_KEY or embeddingApiKey in lucid.config.json)");
  }

  const url = cfg.embeddingUrl ?? "https://api.openai.com/v1/embeddings";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.embeddingApiKey}`,
    },
    body: JSON.stringify({ model: cfg.embeddingModel ?? "text-embedding-3-small", input: texts }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Qdrant REST helpers
// ---------------------------------------------------------------------------

async function qdrantRequest(
  cfg: QdrantCfg,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${cfg.url.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["api-key"] = cfg.apiKey;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

async function ensureCollection(cfg: QdrantCfg): Promise<void> {
  const col = cfg.collection!;
  try {
    await qdrantRequest(cfg, "GET", `/collections/${col}`);
  } catch {
    // Create collection
    await qdrantRequest(cfg, "PUT", `/collections/${col}`, {
      vectors: { size: cfg.vectorDim ?? 1536, distance: "Cosine" },
    });
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const CHUNK_LINES = 80;

function chunkFile(filepath: string, text: string): Array<{ id: number; text: string; chunkIndex: number }> {
  const lines = text.split("\n");
  const chunks: Array<{ id: number; text: string; chunkIndex: number }> = [];

  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const chunkText = lines.slice(i, i + CHUNK_LINES).join("\n");
    const chunkIndex = Math.floor(i / CHUNK_LINES);
    // Deterministic integer ID from filepath + chunk index
    const id = stableId(`${filepath}::${chunkIndex}`);
    chunks.push({ id, text: chunkText, chunkIndex });
  }

  return chunks;
}

function stableId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Ensure positive 32-bit int
  return (h >>> 0) % 2_000_000_000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Index one file into Qdrant (called by sync_file when Qdrant is configured). */
export async function indexFileInQdrant(
  filepath: string,
  text: string,
  cfg: QdrantCfg
): Promise<void> {
  await ensureCollection(cfg);

  const chunks = chunkFile(filepath, text);
  if (chunks.length === 0) return;

  // Batch embed (max 96 texts per request for most providers)
  const BATCH = 32;
  for (let b = 0; b < chunks.length; b += BATCH) {
    const batch = chunks.slice(b, b + BATCH);
    const vectors = await embed(batch.map((c) => c.text), cfg);

    const points = batch.map((c, idx) => ({
      id: c.id,
      vector: vectors[idx]!,
      payload: { filepath, chunkIndex: c.chunkIndex, text: c.text },
    }));

    await qdrantRequest(cfg, "PUT", `/collections/${cfg.collection!}/points`, {
      points,
    });
  }
}

/** Top-k semantic search across all indexed chunks. */
export async function searchQdrant(
  query: string,
  topK: number,
  cfg: QdrantCfg
): Promise<VectorChunk[]> {
  const [queryVec] = await embed([query], cfg);
  if (!queryVec) return [];

  const result = await qdrantRequest(cfg, "POST", `/collections/${cfg.collection!}/points/search`, {
    vector: queryVec,
    limit: topK,
    with_payload: true,
  }) as { result: Array<{ id: number; score: number; payload: Record<string, unknown> }> };

  return result.result.map((r) => ({
    id: r.id,
    filepath: r.payload["filepath"] as string,
    chunkIndex: r.payload["chunkIndex"] as number,
    text: r.payload["text"] as string,
    score: r.score,
  }));
}

/** Check if Qdrant collection exists and is reachable. */
export async function pingQdrant(cfg: QdrantCfg): Promise<boolean> {
  try {
    await qdrantRequest(cfg, "GET", `/collections/${cfg.collection!}`);
    return true;
  } catch {
    return false;
  }
}
