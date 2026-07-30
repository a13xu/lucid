// Reciprocal Rank Fusion — combines ranked lists from heterogeneous retrievers
// (BM25, vector search, TF-IDF) without score normalization.

export const RRF_K = 60;

/**
 * Fuse ranked lists of filepaths. Score per item = Σ 1/(k + rank + 1) over the
 * lists containing it. Empty lists are ignored, so a retriever that returned
 * nothing simply doesn't vote.
 *
 * `priors` adds a boost on the RRF scale: a prior of 1.0 weighs like a #1 rank
 * in one list. Use fractions (e.g. 0.5 for "recently touched").
 */
export function fuseRanks(
  lists: string[][],
  priors?: Map<string, number>,
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const fp = list[rank]!;
      scores.set(fp, (scores.get(fp) ?? 0) + 1 / (k + rank + 1));
    }
  }

  if (priors) {
    const unit = 1 / (k + 1);
    for (const [fp, weight] of priors) {
      if (weight > 0) scores.set(fp, (scores.get(fp) ?? 0) + weight * unit);
    }
  }

  return scores;
}

/**
 * Build an FTS5 MATCH expression from a free-text query: bare identifier-ish
 * terms, quoted and OR-ed. Returns null when the query has no usable terms
 * (caller should skip the FTS leg entirely).
 */
export function toFtsQuery(query: string, maxTerms = 12): string | null {
  const terms = [...new Set(
    (query.toLowerCase().match(/[a-z0-9_$]{2,}/g) ?? []).slice(0, maxTerms)
  )];
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}
