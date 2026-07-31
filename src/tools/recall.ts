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

/** Raw entity search — shared by recall() and smart_context. */
export function recallEntities(stmts: Statements, query: string): EntityWithRelations[] {
  const sanitized = sanitizeFTSQuery(query);
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
    const like = `%${query}%`;
    rows = stmts.searchLike.all(like, like, like);
  }

  return rows.map((row) => buildEntityWithRelations(stmts, row));
}

// Output caps — entities like the project entity accumulate one observation
// per indexed file, so uncapped JSON can exceed the MCP client's per-response
// token limit (~25k). Whole entities are dropped once the budget is hit so the
// output stays a valid JSON array.
const MAX_OBS_PER_ENTITY = 15;
const MAX_OBS_CHARS = 500;
// recall responses carry the JSON twice (text + structuredContent), so keep
// the text half ≤ ~8k tokens → whole response ≤ ~16k, under the ~25k client cap.
const DEFAULT_MAX_CHARS = 32_000;

export function capEntity(e: EntityWithRelations): EntityWithRelations {
  const obs = e.observations
    .slice(0, MAX_OBS_PER_ENTITY)
    .map((o) => (o.length > MAX_OBS_CHARS ? o.slice(0, MAX_OBS_CHARS) + "…" : o));
  if (e.observations.length > MAX_OBS_PER_ENTITY) {
    obs.push(`… +${e.observations.length - MAX_OBS_PER_ENTITY} more observations (use recall_all for the full graph)`);
  }
  return { ...e, observations: obs };
}

export function recall(
  stmts: Statements,
  input: RecallInput,
  opts: { maxChars?: number } = {}
): string {
  const entities = recallEntities(stmts, input.query);
  if (entities.length === 0) {
    return `No results found for "${input.query}".`;
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const kept: EntityWithRelations[] = [];
  let used = 2; // "[]"
  for (const e of entities) {
    const capped = capEntity(e);
    const len = JSON.stringify(capped, null, 2).length;
    if (kept.length > 0 && used + len > maxChars) break;
    kept.push(capped);
    used += len;
  }
  if (kept.length < entities.length) {
    console.error(`[lucid] recall: ${entities.length - kept.length} entities dropped (output budget)`);
  }
  return JSON.stringify(kept, null, 2);
}
