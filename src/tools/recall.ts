import { z } from "zod";
import type { Statements } from "../database.js";
import type { EntityWithRelations, EntityRow } from "../types.js";

export const RecallSchema = z.object({
  query: z.string().min(1),
});

export type RecallInput = z.infer<typeof RecallSchema>;

function sanitizeFTSQuery(query: string): string {
  return query
    .replace(/[^\w\s\u00C0-\u024F]/g, "") // păstrează litere + diacritice
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" OR ");
}

function buildEntityWithRelations(
  stmts: Statements,
  row: EntityRow
): EntityWithRelations {
  const observations: string[] = JSON.parse(row.observations);
  const relRows = stmts.getRelationsForEntity.all(row.id, row.id);

  const relations = relRows.map((r) => ({
    from: r.from_name,
    to: r.to_name,
    type: r.relation_type,
  }));

  return {
    id: row.id,
    name: row.name,
    type: row.type as EntityWithRelations["type"],
    observations,
    created_at: row.created_at,
    updated_at: row.updated_at,
    relations,
  };
}

export function recall(stmts: Statements, input: RecallInput): string {
  const sanitized = sanitizeFTSQuery(input.query);
  let rows: EntityRow[] = [];

  if (sanitized) {
    try {
      rows = stmts.searchFTS.all(sanitized);
    } catch {
      // FTS query invalid — fallback la LIKE
      console.error(`[lucid] FTS fallback for query: ${sanitized}`);
    }
  }

  // Fallback LIKE dacă FTS nu a returnat rezultate
  if (rows.length === 0) {
    const like = `%${input.query}%`;
    rows = stmts.searchLike.all(like, like, like);
  }

  if (rows.length === 0) {
    return `No results found for "${input.query}".`;
  }

  const entities = rows.map((row) => buildEntityWithRelations(stmts, row));
  return JSON.stringify(entities, null, 2);
}
