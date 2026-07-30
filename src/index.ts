#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { initDatabase, prepareStatements } from "./database.js";
import { configureGuard } from "./security/guard.js";
import { allowHost } from "./security/ssrf.js";
import { loadConfig } from "./config.js";
import { checkForUpdatesOnStartup, getCurrentVersion } from "./tools/updater.js";
import { backfillFileFts } from "./indexer/fts-backfill.js";
import { loadLocalConfig } from "./local-llm/config.js";
import { maybeRunCli } from "./cli.js";

import { type RegistryCtx, type ToolMap } from "./registry/shared.js";
import { registerMemoryTools } from "./registry/memory.js";
import { registerIndexingTools } from "./registry/indexing.js";
import { registerRetrievalTools } from "./registry/retrieval.js";
import { registerRewardTools } from "./registry/reward.js";
import { registerGuardianTools } from "./registry/guardian.js";
import { registerPlanTools } from "./registry/plan.js";
import { registerOpsTools } from "./registry/ops.js";
import { registerLocalTools } from "./registry/local.js";
import { registerBookTools } from "./registry/book.js";
import { registerWebdevTools } from "./registry/webdev.js";
import { registerResources } from "./registry/resources.js";
import { registerPrompts } from "./registry/prompts.js";
import { setupToolsets, resolveDisabledDomains } from "./registry/toolsets.js";

// ---------------------------------------------------------------------------
// CLI mode: lucid watch | status | stop | guard | session | local | book
// ---------------------------------------------------------------------------

const cliExit = await maybeRunCli(process.argv);
if (cliExit !== null) process.exit(cliExit);

// ---------------------------------------------------------------------------
// Init DB + security guard
// ---------------------------------------------------------------------------

const db = initDatabase();
const stmts = prepareStatements(db);

const appCfg = loadConfig();
configureGuard(appCfg.security ?? {});

const qdrantUrl = process.env["QDRANT_URL"] ?? appCfg.qdrant?.url;
if (qdrantUrl) { try { allowHost(qdrantUrl); } catch { /* ignore */ } }
const embeddingUrl = process.env["EMBEDDING_URL"] ?? appCfg.qdrant?.embeddingUrl;
if (embeddingUrl) { try { allowHost(embeddingUrl); } catch { /* ignore */ } }
else { allowHost("https://api.openai.com"); }
allowHost("https://registry.npmjs.org");

// Local-LLM endpoint (may be remote — user-opted-in via `lucid local init`)
const localCfg = loadLocalConfig();
if (localCfg?.enabled) {
  try { allowHost(localCfg.endpoint); } catch { /* ignore */ }
}

// FTS5 backfill for DBs indexed before file_text_fts existed (chunked, non-blocking)
backfillFileFts(stmts);

// ---------------------------------------------------------------------------
// MCP Server (high-level McpServer API, SDK 1.27+)
// ---------------------------------------------------------------------------

const SERVER_VERSION = getCurrentVersion();

const server = new McpServer(
  { name: "lucid", version: SERVER_VERSION },
  { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
);

const ctx: RegistryCtx = {
  db,
  stmts,
  cfg: appCfg,
  serverVersion: SERVER_VERSION,
  qdrantUrl,
  embeddingUrl,
};

// ---------------------------------------------------------------------------
// Tools, grouped by domain. Non-core domains start disabled (dynamic toolsets)
// and are enabled per-session via the lucid_toolsets tool.
// ---------------------------------------------------------------------------

const domains: Record<string, ToolMap> = {
  memory: registerMemoryTools(server, ctx),
  indexing: registerIndexingTools(server, ctx),
  retrieval: registerRetrievalTools(server, ctx),
  reward: registerRewardTools(server, ctx),
  guardian: registerGuardianTools(server, ctx),
  plan: registerPlanTools(server, ctx),
  ops: registerOpsTools(server, ctx),
  local: registerLocalTools(server, ctx),
  book: registerBookTools(server, ctx),
  webdev: registerWebdevTools(server, ctx),
};

const disabledAtBoot = resolveDisabledDomains(appCfg.toolsets?.disabled, Object.keys(domains));
setupToolsets(server, domains, disabledAtBoot);

registerResources(server, ctx);
registerPrompts(server);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
const toolCount = Object.values(domains).reduce((n, m) => n + Object.keys(m).length, 0) + 1;
console.error(
  `[lucid] Server v${SERVER_VERSION} started on stdio ` +
  `(${toolCount} tools, ${disabledAtBoot.length ? `hidden domains: ${disabledAtBoot.join(", ")}` : "all domains visible"}).`
);

// Non-blocking — logs to stderr if update is available
checkForUpdatesOnStartup().catch(() => {});
