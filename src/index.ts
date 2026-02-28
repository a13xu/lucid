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
import {
  handleValidateFile, ValidateFileSchema,
  handleCheckDrift, CheckDriftSchema,
  handleGetChecklist,
} from "./tools/guardian.js";
import { handleGrepCode, GrepCodeSchema } from "./tools/grep.js";
import { handleInitProject, InitProjectSchema } from "./tools/init.js";
import {
  handleSyncFile, SyncFileSchema,
  handleSyncProject, SyncProjectSchema,
} from "./tools/sync.js";

// ---------------------------------------------------------------------------
// Init DB
// ---------------------------------------------------------------------------

const db = initDatabase();
const stmts = prepareStatements(db);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "lucid", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Memory ──────────────────────────────────────────────────────────────
    {
      name: "remember",
      description: "Store a fact, decision, or observation about an entity in the knowledge graph.",
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
      description: "Search memory using full-text search. Fast, indexed, supports partial matches and stemming.",
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
    // ── Init / Indexing ──────────────────────────────────────────────────────
    {
      name: "init_project",
      description:
        "Scan and index a project directory into the knowledge graph. " +
        "Reads CLAUDE.md (directives, conventions), package.json / pyproject.toml (dependencies, scripts), " +
        "README.md (description), .mcp.json (MCP servers), logic-guardian.yaml (drift patterns), " +
        "and source files (exported functions/classes). " +
        "Call this once when starting work on a project to bootstrap memory with project context.",
      inputSchema: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Absolute path to the project root. Defaults to current working directory.",
          },
        },
      },
    },
    {
      name: "sync_file",
      description:
        "Index or re-index a single source file after it was written or modified. " +
        "Extracts exports, description, and open TODOs, then updates the knowledge graph. " +
        "IMPORTANT: call this automatically after every Write or Edit tool call.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the modified file." },
        },
        required: ["path"],
      },
    },
    {
      name: "sync_project",
      description:
        "Re-index the entire project directory incrementally. " +
        "Use this when multiple files have changed (e.g. after a refactor or git pull).",
      inputSchema: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Project root directory. Defaults to current working directory.",
          },
        },
      },
    },
    {
      name: "grep_code",
      description:
        "Search indexed source files using a regex pattern. " +
        "Decompresses stored binary content and returns only matching lines with context. " +
        "Token-efficient: returns ~20-50 tokens instead of full file contents. " +
        "Useful for finding function calls, variable usages, import patterns.",
      inputSchema: {
        type: "object",
        properties: {
          pattern:  { type: "string", description: "Regex pattern to search for." },
          language: { type: "string", enum: ["python", "javascript", "typescript", "generic"], description: "Filter by language." },
          context:  { type: "number", description: "Lines of context before/after each match (0-10, default 2)." },
        },
        required: ["pattern"],
      },
    },
    // ── Logic Guardian ───────────────────────────────────────────────────────
    {
      name: "validate_file",
      description:
        "Run Logic Guardian validation on a source file. Detects LLM drift patterns: " +
        "logic inversions, null propagation, type confusion, copy-paste drift, silent exceptions, and more. " +
        "Supports Python, JavaScript, TypeScript. Use after writing or modifying any code.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file to validate." },
        },
        required: ["path"],
      },
    },
    {
      name: "check_drift",
      description:
        "Analyze a code snippet for LLM drift patterns without saving to disk. " +
        "Use this to validate code before writing it to a file.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "The code snippet to analyze." },
          language: {
            type: "string",
            enum: ["python", "javascript", "typescript", "generic"],
            description: "Programming language. Defaults to 'generic'.",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "get_checklist",
      description:
        "Get the full Logic Guardian validation checklist (5 passes). " +
        "Call this before marking any implementation task as done.",
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
      // Memory
      case "remember":    text = remember(stmts, RememberSchema.parse(args)); break;
      case "relate":      text = relate(stmts, RelateSchema.parse(args)); break;
      case "recall":      text = recall(stmts, RecallSchema.parse(args)); break;
      case "recall_all":  text = recallAll(db, stmts); break;
      case "forget":      text = forget(stmts, ForgetSchema.parse(args)); break;
      case "memory_stats": text = memoryStats(db, stmts); break;

      // Init & Sync
      case "init_project":  text = handleInitProject(stmts, InitProjectSchema.parse(args)); break;
      case "sync_file":     text = handleSyncFile(stmts, SyncFileSchema.parse(args)); break;
      case "sync_project":  text = handleSyncProject(stmts, SyncProjectSchema.parse(args)); break;

      // Grep
      case "grep_code":     text = handleGrepCode(stmts, GrepCodeSchema.parse(args)); break;

      // Logic Guardian
      case "validate_file": text = handleValidateFile(ValidateFileSchema.parse(args)); break;
      case "check_drift":   text = handleCheckDrift(CheckDriftSchema.parse(args)); break;
      case "get_checklist": text = handleGetChecklist(); break;

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof z.ZodError
      ? `Validation error: ${err.errors.map((e) => e.message).join(", ")}`
      : err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[lucid] Server started on stdio.");
