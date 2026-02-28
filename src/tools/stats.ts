import { statSync } from "fs";
import Database from "better-sqlite3";
import type { Statements } from "../database.js";
import type { MemoryStats } from "../types.js";

export function memoryStats(db: Database.Database, stmts: Statements): string {
  const entityCount = stmts.countEntities.get()!.count;
  const relationCount = stmts.countRelations.get()!.count;
  const walMode = stmts.getWalMode.get()!.journal_mode === "wal";

  // Numără observațiile
  const allEntities = stmts.getAllEntities.all();
  let observationCount = 0;
  for (const row of allEntities) {
    const obs: string[] = JSON.parse(row.observations);
    observationCount += obs.length;
  }

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(db.name).size;
  } catch {
    // in-memory sau inaccesibil
  }

  const stats: MemoryStats = {
    entity_count: entityCount,
    relation_count: relationCount,
    observation_count: observationCount,
    db_size_bytes: dbSizeBytes,
    db_size_kb: Math.round(dbSizeBytes / 1024),
    wal_mode: walMode,
    fts5_enabled: true,
  };

  return JSON.stringify(stats, null, 2);
}
