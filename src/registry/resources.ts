import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { memoryStats } from "../tools/stats.js";
import { recallAll } from "../tools/recall-all.js";
import { handleGetRecent } from "../tools/context.js";
import { handlePlanList } from "../tools/plan.js";
import { handleGetChecklist } from "../tools/guardian.js";
import { handleGetCodingRules } from "../tools/coding-guard.js";
import type { RegistryCtx } from "./shared.js";

export function registerResources(server: McpServer, ctx: RegistryCtx): void {
  const { db, stmts, cfg, serverVersion, qdrantUrl, embeddingUrl } = ctx;

  server.registerResource("memory-stats", "lucid://memory/stats", {
    title: "Memory Stats",
    description: "Current memory usage: entity/relation/observation counts and DB size.",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: memoryStats(db, stmts) }],
  }));

  server.registerResource("memory-graph", "lucid://memory/graph", {
    title: "Memory Graph",
    description: "Full knowledge graph snapshot: all entities, relations, and observations.",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: recallAll(db, stmts) }],
  }));

  server.registerResource(
    "memory-recent",
    new ResourceTemplate("lucid://memory/recent/{hours}", { list: undefined }),
    {
      title: "Recent Activity",
      description: "Files modified in the last {hours} hours, with line-level diffs.",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const hours = Number(vars["hours"]);
      const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 720) : 24;
      const text = handleGetRecent(stmts, { hours: safeHours, withDiffs: true });
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource("plan-list", "lucid://plan/list", {
    title: "Active Plans",
    description: "All active development plans with progress summary.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: handlePlanList(stmts, { status: "active" }),
    }],
  }));

  server.registerResource("checklist", "lucid://guardian/checklist", {
    title: "Logic Guardian Checklist",
    description: "Full 5-pass validation checklist Claude must run before completing any task.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: handleGetChecklist() }],
  }));

  server.registerResource("coding-rules", "lucid://guardian/coding-rules", {
    title: "25 Golden Rules",
    description: "Coding-quality checklist: clarity, naming, single responsibility, frontend rules.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: handleGetCodingRules() }],
  }));

  server.registerResource("config", "lucid://config", {
    title: "Lucid Configuration",
    description: "Effective configuration (lucid.config.json + env overrides).",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify({
        version: serverVersion,
        config: cfg,
        env: {
          MEMORY_DB_PATH: process.env["MEMORY_DB_PATH"] ?? null,
          QDRANT_URL: qdrantUrl ?? null,
          EMBEDDING_URL: embeddingUrl ?? null,
        },
      }, null, 2),
    }],
  }));
}
