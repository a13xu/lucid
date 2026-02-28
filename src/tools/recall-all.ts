import { statSync } from "fs";
import Database from "better-sqlite3";
import type { Statements } from "../database.js";
import type { KnowledgeGraph, EntityWithRelations } from "../types.js";

export function recallAll(db: Database.Database, stmts: Statements): string {
  const entityCount = stmts.countEntities.get()!.count;
  const relationCount = stmts.countRelations.get()!.count;

  const allEntities = stmts.getAllEntities.all();
  const allRelations = stmts.getAllRelations.all();

  // Numără toate observațiile
  let observationCount = 0;
  const entities: EntityWithRelations[] = allEntities.map((row) => {
    const observations: string[] = JSON.parse(row.observations);
    observationCount += observations.length;

    const relations = allRelations
      .filter((r) => r.from_entity === row.id || r.to_entity === row.id)
      .map((r) => ({ from: r.from_name, to: r.to_name, type: r.relation_type }));

    return {
      id: row.id,
      name: row.name,
      type: row.type as EntityWithRelations["type"],
      observations,
      created_at: row.created_at,
      updated_at: row.updated_at,
      relations,
    };
  });

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(db.name).size;
  } catch {
    // fișierul poate fi in-memory sau inaccesibil
  }

  const graph: KnowledgeGraph = {
    stats: {
      entity_count: entityCount,
      relation_count: relationCount,
      observation_count: observationCount,
      db_size_bytes: dbSizeBytes,
      db_size_kb: Math.round(dbSizeBytes / 1024),
      wal_mode: true,
      fts5_enabled: true,
    },
    entities,
  };

  return JSON.stringify(graph, null, 2);
}
