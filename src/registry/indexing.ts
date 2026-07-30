import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { handleInitProject, InitProjectSchema } from "../tools/init.js";
import {
  handleSyncFile, SyncFileSchema,
  handleSyncProject, SyncProjectSchema,
} from "../tools/sync.js";
import { handleGrepCode, GrepCodeSchema } from "../tools/grep.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerIndexingTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { stmts } = ctx;

  return {
    init_project: server.registerTool("init_project", {
      title: "Init Project",
      description:
        "Scan and index a project directory into the knowledge graph. " +
        "Reads CLAUDE.md, package.json/pyproject.toml, README.md, .mcp.json, logic-guardian.yaml, " +
        "and source files (exported functions/classes). Call once when starting work on a project.",
      inputSchema: InitProjectSchema.shape,
    }, tx("init_project", async (args) => handleInitProject(stmts, args))),

    sync_file: server.registerTool("sync_file", {
      title: "Sync File",
      description:
        "Index or re-index a single source file after it was written or modified. " +
        "IMPORTANT: call this automatically after every Write or Edit tool call.",
      inputSchema: SyncFileSchema.shape,
    }, tx("sync_file", (args) => handleSyncFile(stmts, args))),

    sync_project: server.registerTool("sync_project", {
      title: "Sync Project",
      description: "Re-index the entire project directory incrementally (after refactor or git pull).",
      inputSchema: SyncProjectSchema.shape,
    }, tx("sync_project", (args) => handleSyncProject(stmts, args))),

    grep_code: server.registerTool("grep_code", {
      title: "Grep Code",
      description:
        "Search indexed source files using a regex pattern. Decompresses stored content and returns " +
        "only matching lines with context. Token-efficient (~20-50 tokens vs full file).",
      inputSchema: GrepCodeSchema.shape,
    }, tx("grep_code", (args) => handleGrepCode(stmts, args))),
  };
}
