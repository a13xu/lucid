// TF-IDF scoring — pure JS, no external deps
// Used as the default relevance engine when Qdrant is not configured

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "its", "let", "may", "new", "now", "old", "own", "say", "she",
  "too", "use", "way", "who", "will", "with", "that", "this", "from",
  "they", "been", "have", "their", "said", "each", "which", "what",
  // code keywords (too common to be discriminative)
  "return", "const", "import", "export", "function", "class", "type",
  "interface", "string", "number", "boolean", "void", "null", "undefined",
  "async", "await", "true", "false", "default", "module", "require",
  "self", "def", "pass", "else", "elif", "then", "end", "var", "let",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export interface ScoredFile {
  filepath: string;
  score: number;
  matchedTerms: string[];
}

// ---------------------------------------------------------------------------
// Per-document term stats, memoized by content_hash (self-invalidating:
// changed content → new hash). Tokenization dominates ranking cost.
// ---------------------------------------------------------------------------

interface DocStats {
  tf: Map<string, number>;
  totalTokens: number;
}

const TF_CACHE_MAX_DOCS = 2000;
const tfCache = new Map<string, DocStats>();

function computeDocStats(text: string): DocStats {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tf, totalTokens: Math.max(tokens.length, 1) };
}

function getDocStats(text: string, hash?: string): DocStats {
  if (hash !== undefined) {
    const hit = tfCache.get(hash);
    if (hit !== undefined) {
      tfCache.delete(hash);
      tfCache.set(hash, hit);
      return hit;
    }
  }
  const stats = computeDocStats(text);
  if (hash !== undefined) {
    tfCache.set(hash, stats);
    while (tfCache.size > TF_CACHE_MAX_DOCS) {
      tfCache.delete(tfCache.keys().next().value as string);
    }
  }
  return stats;
}

export function invalidateTfidfCache(): void {
  tfCache.clear();
}

/**
 * Rank files by TF-IDF relevance to a query.
 * Returns all files sorted by score descending (score=0 files included at bottom).
 * Pass `hash` (content hash) per file to reuse memoized term stats across queries.
 */
export function rankByRelevance(
  query: string,
  files: Array<{ filepath: string; text: string; hash?: string }>
): ScoredFile[] {
  if (files.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return files.map((f) => ({ filepath: f.filepath, score: 0, matchedTerms: [] }));
  }

  const N = files.length;

  const docStats = files.map((f) => getDocStats(f.text, f.hash));

  // Document frequencies over this file set
  const df = new Map<string, number>();
  for (const stats of docStats) {
    for (const term of stats.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const results: ScoredFile[] = [];

  for (let i = 0; i < files.length; i++) {
    const { tf, totalTokens } = docStats[i]!;
    let score = 0;
    const matched: string[] = [];

    for (const qt of queryTerms) {
      const freq = tf.get(qt) ?? 0;
      if (freq > 0) {
        const tfScore = freq / totalTokens;
        const idf = Math.log((N + 1) / ((df.get(qt) ?? 0) + 1)) + 1;
        score += tfScore * idf;
        matched.push(qt);
      }
    }

    results.push({ filepath: files[i]!.filepath, score, matchedTerms: matched });
  }

  return results.sort((a, b) => b.score - a.score);
}
