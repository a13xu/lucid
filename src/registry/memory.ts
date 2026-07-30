import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { remember, RememberSchema } from "../tools/remember.js";
import { relate, RelateSchema } from "../tools/relate.js";
import { recall, RecallSchema } from "../tools/recall.js";
import { recallAll } from "../tools/recall-all.js";
import { forget, ForgetSchema } from "../tools/forget.js";
import { memoryStats } from "../tools/stats.js";
import { tx, type RegistryCtx, type ToolMap, type ToolReturn } from "./shared.js";

// Output schemas (Zod raw shapes) for structured-content tools
export const memoryStatsOutputShape = {
  entity_count: z.number().int(),
  relation_count: z.number().int(),
  observation_count: z.number().int(),
  db_size_bytes: z.number().int(),
  db_size_kb: z.number().int(),
  wal_mode: z.boolean(),
  fts5_enabled: z.boolean(),
} as const;

const entityShape = {
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  observations: z.array(z.string()),
  created_at: z.number(),
  updated_at: z.number(),
  relations: z.array(z.object({
    from: z.string(), to: z.string(), type: z.string(),
  })),
} as const;

const recallAllOutputShape = {
  stats: z.object(memoryStatsOutputShape),
  entities: z.array(z.object(entityShape)),
} as const;

const recallOutputShape = {
  entities: z.array(z.object(entityShape)),
} as const;

export function registerMemoryTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { db, stmts } = ctx;

  // Helpers that produce both text + structured output for tools whose handlers
  // already return JSON. Avoids touching downstream handler files.

  const memoryStatsRich = (): ToolReturn => {
    const text = memoryStats(db, stmts);
    return { text, structured: JSON.parse(text) as Record<string, unknown> };
  };

  const recallAllRich = (): ToolReturn => {
    const text = recallAll(db, stmts);
    return { text, structured: JSON.parse(text) as Record<string, unknown> };
  };

  const recallRich = (args: z.infer<typeof RecallSchema>): ToolReturn => {
    const text = recall(stmts, args);
    // recall returns either "No results..." text or JSON array.
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try { return { text, structured: { entities: JSON.parse(text) } }; }
      catch { return text; }
    }
    return text;
  };

  return {
    remember: server.registerTool("remember", {
      title: "Remember",
      description: "Store a fact, decision, or observation about an entity in the knowledge graph.",
      inputSchema: RememberSchema.shape,
    }, tx("remember", (args) => remember(stmts, args))),

    relate: server.registerTool("relate", {
      title: "Relate",
      description: "Create a directed relationship between two entities in the knowledge graph.",
      inputSchema: RelateSchema.shape,
    }, tx("relate", (args) => relate(stmts, args))),

    recall: server.registerTool("recall", {
      title: "Recall",
      description: "Search memory using full-text search. Fast, indexed, supports partial matches and stemming.",
      inputSchema: RecallSchema.shape,
      outputSchema: recallOutputShape,
    }, tx("recall", (args) => recallRich(args))),

    recall_all: server.registerTool("recall_all", {
      title: "Recall All",
      description: "Get the entire knowledge graph with statistics.",
      outputSchema: recallAllOutputShape,
    }, tx("recall_all", () => recallAllRich())),

    forget: server.registerTool("forget", {
      title: "Forget",
      description: "Remove an entity and all its relations from memory.",
      inputSchema: ForgetSchema.shape,
    }, tx("forget", (args) => forget(stmts, args))),

    memory_stats: server.registerTool("memory_stats", {
      title: "Memory Stats",
      description: "Get memory usage statistics.",
      outputSchema: memoryStatsOutputShape,
    }, tx("memory_stats", () => memoryStatsRich())),
  };
}
