import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handleBackupFile, BackupFileSchema,
  handleRestoreFile, RestoreFileSchema,
  handleCheckTruncateRisk, CheckTruncateRiskSchema,
} from "../tools/backup.js";
import { handleSessionStatus, SessionStatusSchema } from "../tools/session.js";
import { UpdateLucidSchema, handleUpdateLucid } from "../tools/updater.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerOpsTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { stmts } = ctx;

  return {
    session_status: server.registerTool("session_status", {
      title: "Session Status",
      description:
        "Show recent Claude Code sessions with prompt counts, idle time, and /compact " +
        "history. Use to inspect when /compact or /clear hints are about to fire.",
      inputSchema: SessionStatusSchema.shape,
    }, tx("session_status", (args) => handleSessionStatus(stmts, args))),

    backup_file: server.registerTool("backup_file", {
      title: "Backup File",
      description:
        "Snapshot the current on-disk content of a file into Lucid's versioned backup store " +
        "(zlib-compressed, last 10 versions kept). Use before risky edits.",
      inputSchema: BackupFileSchema.shape,
    }, tx("backup_file", (args) => handleBackupFile(stmts, args))),

    restore_file: server.registerTool("restore_file", {
      title: "Restore File",
      description:
        "Restore a file from a previous Lucid backup. version=1 is the latest snapshot, " +
        "2 is the one before, etc. Pass dry_run=true to preview without writing.",
      inputSchema: RestoreFileSchema.shape,
    }, tx("restore_file", (args) => handleRestoreFile(stmts, args))),

    check_truncate_risk: server.registerTool("check_truncate_risk", {
      title: "Check Truncate Risk",
      description:
        "Assess whether writing new_content (or new_size) to path would constitute a destructive " +
        "truncate (empty/whitespace overwrite, >70% shrink, or active cascade lock). Read-only by default.",
      inputSchema: CheckTruncateRiskSchema.shape,
    }, tx("check_truncate_risk", (args) => handleCheckTruncateRisk(stmts, args))),

    update_lucid: server.registerTool("update_lucid", {
      title: "Update Lucid",
      description:
        "Check for a newer version of Lucid on npm and update automatically. " +
        "Restart Claude Code after updating.",
      inputSchema: UpdateLucidSchema.shape,
    }, tx("update_lucid", async (args) => handleUpdateLucid(args))),
  };
}
