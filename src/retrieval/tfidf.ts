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

/**
 * Rank files by TF-IDF relevance to a query.
 * Returns all files sorted by score descending (score=0 files included at bottom).
 */
export function rankByRelevance(
  query: string,
  files: Array<{ filepath: string; text: string }>
): ScoredFile[] {
  if (files.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return files.map((f) => ({ filepath: f.filepath, score: 0, matchedTerms: [] }));
  }

  const N = files.length;

  // Compute per-doc term frequencies + document frequencies
  const df = new Map<string, number>();
  const docTF: Map<string, number>[] = [];

  for (const file of files) {
    const tokens = tokenize(file.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTF.push(tf);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const results: ScoredFile[] = [];

  for (let i = 0; i < files.length; i++) {
    const tf = docTF[i]!;
    const totalTokens = Math.max([...tf.values()].reduce((a, b) => a + b, 0), 1);
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
