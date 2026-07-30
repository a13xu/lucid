// One-time FTS5 backfill for databases indexed before file_text_fts existed.
// Runs in chunks on setImmediate so it never blocks the MCP stdio handshake.

import type { Statements } from "../database.js";
import { decompress } from "../store/content.js";

const CHUNK_SIZE = 200;

export function backfillFileFts(stmts: Statements, onDone?: (indexed: number) => void): void {
  let total = 0;

  const step = (): void => {
    let rows;
    try {
      rows = stmts.getFilesMissingFts.all(CHUNK_SIZE);
    } catch {
      return;
    }
    if (rows.length === 0) {
      if (total > 0) {
        process.stderr.write(`[Lucid] FTS backfill complete: ${total} file(s) indexed.\n`);
      }
      onDone?.(total);
      return;
    }
    for (const row of rows) {
      try {
        // No content_hash passed: backfill must not churn the hot LRU cache
        stmts.insertFileFts.run(row.filepath, decompress(row.content));
        total++;
      } catch {
        // Corrupt blob — insert a stub so the row is not retried forever
        try { stmts.insertFileFts.run(row.filepath, ""); } catch { /* give up on this row */ }
      }
    }
    setImmediate(step);
  };

  setImmediate(step);
}
