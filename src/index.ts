#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { initDatabase, prepareStatements } from "./database.js";
import { remember, RememberSchema } from "./tools/remember.js";
import { relate, RelateSchema } from "./tools/relate.js";
import { recall, RecallSchema } from "./tools/recall.js";
import { recallAll } from "./tools/recall-all.js";
import { forget, ForgetSchema } from "./tools/forget.js";
import { memoryStats } from "./tools/stats.js";

// ---------------------------------------------------------------------------
// Init DB
// ---------------------------------------------------------------------------

const db = initDatabase();
const stmts = prepareStatements(db);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "lucid", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description:
        "Store a fact, decision, or observation about an entity in the knowledge graph.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity name (project, person, concept, tool)" },
          entityType: {
            type: "string",
            enum: ["person", "project", "decision", "pattern", "tool", "config", "bug", "convention"],
          },
          observation: { type: "string", description: "The fact to remember" },
        },
        required: ["entity", "entityType", "observation"],
      },
    },
    {
      name: "relate",
      description: "Create a directed relationship between two entities in the knowledge graph.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source entity name" },
          to: { type: "string", description: "Target entity name" },
          relationType: {
            type: "string",
            enum: ["uses", "depends_on", "created_by", "part_of", "replaced_by", "conflicts_with", "tested_by"],
          },
        },
        required: ["from", "to", "relationType"],
      },
    },
    {
      name: "recall",
      description:
        "Search memory using full-text search. Fast, indexed, supports partial matches and stemming.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms" },
        },
        required: ["query"],
      },
    },
    {
      name: "recall_all",
      description: "Get the entire knowledge graph with statistics.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "forget",
      description: "Remove an entity and all its relations from memory.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity name to remove" },
        },
        required: ["entity"],
      },
    },
    {
      name: "memory_stats",
      description: "Get memory usage statistics.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let text: string;

    switch (name) {
      case "remember": {
        const input = RememberSchema.parse(args);
        text = remember(stmts, input);
        break;
      }
      case "relate": {
        const input = RelateSchema.parse(args);
        text = relate(stmts, input);
        break;
      }
      case "recall": {
        const input = RecallSchema.parse(args);
        text = recall(stmts, input);
        break;
      }
      case "recall_all": {
        text = recallAll(db, stmts);
        break;
      }
      case "forget": {
        const input = ForgetSchema.parse(args);
        text = forget(stmts, input);
        break;
      }
      case "memory_stats": {
        text = memoryStats(db, stmts);
        break;
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof z.ZodError
      ? `Validation error: ${err.errors.map((e) => e.message).join(", ")}`
      : err instanceof Error
        ? err.message
        : String(err);

    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[lucid] Server started on stdio.");
