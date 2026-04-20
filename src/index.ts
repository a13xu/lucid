#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { initDatabase, prepareStatements } from "./database.js";
import { guardRequest, guardOutput, configureGuard } from "./security/guard.js";
import { allowHost } from "./security/ssrf.js";
import { loadConfig } from "./config.js";
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
import {
  handleGetContext, GetContextSchema,
  handleGetRecent, GetRecentSchema,
} from "./tools/context.js";
import {
  handleReward, RewardSchema,
  handlePenalize, PenalizeSchema,
  handleShowRewards, ShowRewardsSchema,
} from "./tools/reward.js";
import {
  handleGetCodingRules,
  handleCheckCodeQuality, CheckCodeQualitySchema,
} from "./tools/coding-guard.js";
import {
  handlePlanCreate, PlanCreateSchema,
  handlePlanList,   PlanListSchema,
  handlePlanGet,    PlanGetSchema,
  handlePlanUpdateTask, PlanUpdateTaskSchema,
} from "./tools/plan.js";
import {
  UpdateLucidSchema, handleUpdateLucid, checkForUpdatesOnStartup, getCurrentVersion,
} from "./tools/updater.js";
import {
  GenerateComponentSchema, handleGenerateComponent,
  ScaffoldPageSchema,      handleScaffoldPage,
  SeoMetaSchema,           handleSeoMeta,
  AccessibilityAuditSchema, handleAccessibilityAudit,
  ApiClientSchema,         handleApiClient,
  TestGeneratorSchema,     handleTestGenerator,
  ResponsiveLayoutSchema,  handleResponsiveLayout,
  SecurityScanSchema,      handleSecurityScan,
  DesignTokensSchema,      handleDesignTokens,
  PerfHintsSchema,         handlePerfHints,
} from "./tools/webdev/index.js";
import { handleSmartContext, SmartContextSchema } from "./tools/smart-context.js";
import { handleSuggestModel, SuggestModelSchema } from "./tools/model-advisor.js";
import { handleCompressText, CompressTextSchema } from "./tools/compress.js";

// ---------------------------------------------------------------------------
// CLI mode: lucid watch | lucid status | lucid stop
// ---------------------------------------------------------------------------

const [,, _cliCmd, ..._cliArgs] = process.argv;

if (_cliCmd === "watch" || _cliCmd === "status" || _cliCmd === "stop") {
  await runCli(_cliCmd, _cliArgs);
  process.exit(0);
}

async function runCli(cmd: string, args: string[]): Promise<void> {
  const { join } = await import("path");
  const { homedir } = await import("os");
  const { existsSync, mkdirSync, writeFileSync, readFileSync } = await import("fs");

  const PID_DIR = join(homedir(), ".lucid");
  const PID_FILE = join(PID_DIR, "watch.pid");

  if (cmd === "status") {
    if (!existsSync(PID_FILE)) { console.log("Lucid daemon: not running"); return; }
    const pid = readFileSync(PID_FILE, "utf-8").trim();
    try { process.kill(Number(pid), 0); console.log(`Lucid daemon: running (PID ${pid})`); }
    catch { console.log("Lucid daemon: not running (stale PID file)"); }
    return;
  }

  if (cmd === "stop") {
    if (!existsSync(PID_FILE)) { console.log("Lucid daemon: not running"); return; }
    const pid = readFileSync(PID_FILE, "utf-8").trim();
    try { process.kill(Number(pid), "SIGTERM"); console.log(`Lucid daemon stopped (PID ${pid})`); }
    catch { console.log("Lucid daemon: not running (stale PID file)"); }
    return;
  }

  // cmd === "watch"
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 7821;
  const noHttp = args.includes("--no-http");
  const watchDir = args.find((a) => !a.startsWith("--")) ?? process.cwd();

  const { initDatabase, prepareStatements } = await import("./database.js");
  const db = initDatabase();
  const stmts = prepareStatements(db);

  if (!noHttp) {
    const { startHttpServer } = await import("./http/server.js");
    startHttpServer(stmts, { port });
  }

  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid), "utf-8");

  const chokidar = await import("chokidar");
  const watcher = chokidar.watch(watchDir, {
    ignored: [/node_modules/, /\.git/, /[/\\]build[/\\]/, /[/\\]dist[/\\]/, /\.d\.ts$/],
    persistent: true,
    ignoreInitial: true,
  });

  const DEBOUNCE_MS = 300;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const syncPath = (filePath: string): void => {
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);
    timers.set(filePath, setTimeout(() => {
      timers.delete(filePath);
      if (!noHttp) {
        fetch(`http://localhost:${port}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath }),
        }).catch(() => {});
      } else {
        import("./tools/sync.js").then(({ handleSyncFile }) => {
          handleSyncFile(stmts, { path: filePath });
        }).catch(() => {});
      }
    }, DEBOUNCE_MS));
  };

  watcher.on("add", syncPath).on("change", syncPath);
  process.stderr.write(`[Lucid] Watching ${watchDir}${noHttp ? " (no HTTP)" : ` on port ${port}`}\n`);

  const shutdown = (): void => {
    watcher.close().catch(() => {});
    try { db.pragma("wal_checkpoint(FULL)"); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<never>(() => { /* keep alive */ });
}

// ---------------------------------------------------------------------------
// Init DB
// ---------------------------------------------------------------------------

const db = initDatabase();
const stmts = prepareStatements(db);

// ---------------------------------------------------------------------------
// Security guard — initialize from config + env
// ---------------------------------------------------------------------------

const _appCfg = loadConfig();
configureGuard(_appCfg.security ?? {});

const _qdrantUrl = process.env["QDRANT_URL"] ?? _appCfg.qdrant?.url;
if (_qdrantUrl) { try { allowHost(_qdrantUrl); } catch { /* ignore */ } }
const _embeddingUrl = process.env["EMBEDDING_URL"] ?? _appCfg.qdrant?.embeddingUrl;
if (_embeddingUrl) { try { allowHost(_embeddingUrl); } catch { /* ignore */ } }
else { allowHost("https://api.openai.com"); }

// ---------------------------------------------------------------------------
// MCP Server (high-level McpServer API, SDK 1.27+)
// ---------------------------------------------------------------------------

const SERVER_VERSION = getCurrentVersion();

const server = new McpServer(
  { name: "lucid", version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// ---------------------------------------------------------------------------
// Shared tool result wrapper: rate-limit + WAF + output secret scan + errors.
// Handler may return a string OR { text, structured }.
// ---------------------------------------------------------------------------

type ToolReturn = string | { text: string; structured: Record<string, unknown> };

function tx<I>(name: string, handler: (args: I) => ToolReturn | Promise<ToolReturn>) {
  return async (args: I) => {
    const guard = guardRequest(name, args as Record<string, unknown>);
    if (guard.blocked) {
      return {
        content: [{ type: "text" as const, text: guard.reason ?? "Request blocked by security guard" }],
        isError: true,
      };
    }
    try {
      const out = await handler(args);
      if (typeof out === "string") {
        return { content: [{ type: "text" as const, text: guardOutput(name, out) }] };
      }
      return {
        content: [{ type: "text" as const, text: guardOutput(name, out.text) }],
        structuredContent: out.structured,
      };
    } catch (err) {
      const msg = err instanceof z.ZodError
        ? `Validation error: ${err.errors.map((e) => e.message).join(", ")}`
        : err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  };
}

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

// Output schemas (Zod raw shapes) for structured-content tools
const memoryStatsOutputShape = {
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

// ---------------------------------------------------------------------------
// Tools — Memory
// ---------------------------------------------------------------------------

server.registerTool("remember", {
  title: "Remember",
  description: "Store a fact, decision, or observation about an entity in the knowledge graph.",
  inputSchema: RememberSchema.shape,
}, tx("remember", (args) => remember(stmts, args)));

server.registerTool("relate", {
  title: "Relate",
  description: "Create a directed relationship between two entities in the knowledge graph.",
  inputSchema: RelateSchema.shape,
}, tx("relate", (args) => relate(stmts, args)));

server.registerTool("recall", {
  title: "Recall",
  description: "Search memory using full-text search. Fast, indexed, supports partial matches and stemming.",
  inputSchema: RecallSchema.shape,
  outputSchema: recallOutputShape,
}, tx("recall", (args) => recallRich(args)));

server.registerTool("recall_all", {
  title: "Recall All",
  description: "Get the entire knowledge graph with statistics.",
  outputSchema: recallAllOutputShape,
}, tx("recall_all", () => recallAllRich()));

server.registerTool("forget", {
  title: "Forget",
  description: "Remove an entity and all its relations from memory.",
  inputSchema: ForgetSchema.shape,
}, tx("forget", (args) => forget(stmts, args)));

server.registerTool("memory_stats", {
  title: "Memory Stats",
  description: "Get memory usage statistics.",
  outputSchema: memoryStatsOutputShape,
}, tx("memory_stats", () => memoryStatsRich()));

// ---------------------------------------------------------------------------
// Tools — Init / Indexing
// ---------------------------------------------------------------------------

server.registerTool("init_project", {
  title: "Init Project",
  description:
    "Scan and index a project directory into the knowledge graph. " +
    "Reads CLAUDE.md, package.json/pyproject.toml, README.md, .mcp.json, logic-guardian.yaml, " +
    "and source files (exported functions/classes). Call once when starting work on a project.",
  inputSchema: InitProjectSchema.shape,
}, tx("init_project", async (args) => handleInitProject(stmts, args)));

server.registerTool("sync_file", {
  title: "Sync File",
  description:
    "Index or re-index a single source file after it was written or modified. " +
    "IMPORTANT: call this automatically after every Write or Edit tool call.",
  inputSchema: SyncFileSchema.shape,
}, tx("sync_file", (args) => handleSyncFile(stmts, args)));

server.registerTool("sync_project", {
  title: "Sync Project",
  description: "Re-index the entire project directory incrementally (after refactor or git pull).",
  inputSchema: SyncProjectSchema.shape,
}, tx("sync_project", (args) => handleSyncProject(stmts, args)));

server.registerTool("grep_code", {
  title: "Grep Code",
  description:
    "Search indexed source files using a regex pattern. Decompresses stored content and returns " +
    "only matching lines with context. Token-efficient (~20-50 tokens vs full file).",
  inputSchema: GrepCodeSchema.shape,
}, tx("grep_code", (args) => handleGrepCode(stmts, args)));

// ---------------------------------------------------------------------------
// Tools — Context & Token Optimization
// ---------------------------------------------------------------------------

server.registerTool("get_context", {
  title: "Get Context",
  description:
    "Retrieve the minimal relevant context for a task or query. TF-IDF (or Qdrant) ranking " +
    "+ recency boost + skeleton pruning to stay within token budget.",
  inputSchema: GetContextSchema.shape,
}, tx("get_context", async (args) => handleGetContext(stmts, args)));

server.registerTool("get_recent", {
  title: "Get Recent",
  description:
    "Return files modified recently with line-level diffs. Useful after a git pull or session resume.",
  inputSchema: GetRecentSchema.shape,
}, tx("get_recent", (args) => handleGetRecent(stmts, args)));

server.registerTool("smart_context", {
  title: "Smart Context",
  description:
    "Combined: knowledge graph (recall) + code files (get_context) in one call. " +
    "task_type adjusts token budget: simple=2000, moderate=6000, complex=12000.",
  inputSchema: SmartContextSchema.shape,
}, tx("smart_context", async (args) => handleSmartContext(stmts, args)));

server.registerTool("suggest_model", {
  title: "Suggest Model",
  description:
    "Classify task complexity → recommend Claude model. Returns { model, model_id, reasoning, context_budget }. " +
    "Call at the start of any workflow.",
  inputSchema: SuggestModelSchema.shape,
}, tx("suggest_model", (args) => handleSuggestModel(args)));

server.registerTool("compress_text", {
  title: "Compress Text",
  description:
    "Compress text using LLMLingua-2 semantic compression. Model downloads ~700MB on first use " +
    "(cached in ~/.lucid/models/). Returns compressed text with stats.",
  inputSchema: CompressTextSchema.shape,
}, tx("compress_text", async (args) => handleCompressText(args)));

// ---------------------------------------------------------------------------
// Tools — Reward System
// ---------------------------------------------------------------------------

server.registerTool("reward", {
  title: "Reward",
  description:
    "Signal that the last get_context() result was helpful (+1 reward). " +
    "Files in that context will be ranked higher in future similar queries.",
  inputSchema: RewardSchema.shape,
}, tx("reward", (args) => handleReward(stmts, args)));

server.registerTool("penalize", {
  title: "Penalize",
  description:
    "Signal that the last get_context() result was unhelpful (-1 reward). " +
    "Files in that context will be ranked lower in future similar queries.",
  inputSchema: PenalizeSchema.shape,
}, tx("penalize", (args) => handlePenalize(stmts, args)));

server.registerTool("show_rewards", {
  title: "Show Rewards",
  description:
    "Show the top rewarded experiences and most rewarded files. " +
    "Rewards decay exponentially (half-life ~14 days).",
  inputSchema: ShowRewardsSchema.shape,
}, tx("show_rewards", (args) => handleShowRewards(stmts, args)));

// ---------------------------------------------------------------------------
// Tools — Logic Guardian
// ---------------------------------------------------------------------------

server.registerTool("validate_file", {
  title: "Validate File",
  description:
    "Run Logic Guardian validation on a source file. Detects LLM drift: logic inversions, " +
    "null propagation, type confusion, copy-paste drift, silent exceptions. Python/JS/TS.",
  inputSchema: ValidateFileSchema.shape,
}, tx("validate_file", (args) => handleValidateFile(args)));

server.registerTool("check_drift", {
  title: "Check Drift",
  description: "Analyze a code snippet for LLM drift patterns without saving to disk.",
  inputSchema: CheckDriftSchema.shape,
}, tx("check_drift", (args) => handleCheckDrift(args)));

server.registerTool("get_checklist", {
  title: "Get Checklist",
  description: "Get the full Logic Guardian validation checklist (5 passes).",
}, tx("get_checklist", () => handleGetChecklist()));

// ---------------------------------------------------------------------------
// Tools — Coding Guard
// ---------------------------------------------------------------------------

server.registerTool("coding_rules", {
  title: "Coding Rules",
  description:
    "Get the 25 Golden Rules coding checklist. Covers clarity, naming, single responsibility, " +
    "frontend rules, library selection, architecture separation.",
}, tx("coding_rules", () => handleGetCodingRules()));

// CheckCodeQualitySchema uses .refine(); pass the raw shape to MCP and re-parse
// inside the handler so the refinement runs.
const checkCodeQualityShape = {
  path: z.string().optional().describe("Absolute or relative path to the file to analyze."),
  code: z.string().optional().describe("Code snippet to analyze inline."),
  language: z.enum(["python", "javascript", "typescript", "vue", "generic"]).optional()
    .describe("Language hint. Auto-detected from file extension if path is provided."),
} as const;

server.registerTool("check_code_quality", {
  title: "Check Code Quality",
  description:
    "Analyze a file or snippet against the 25 Golden Rules. Detects size violations, vague naming, " +
    "deep nesting, dead code, inline styles, prop explosion, fetch-in-component.",
  inputSchema: checkCodeQualityShape,
}, tx("check_code_quality", (args) => handleCheckCodeQuality(CheckCodeQualitySchema.parse(args))));

// ---------------------------------------------------------------------------
// Tools — Planning
// ---------------------------------------------------------------------------

server.registerTool("plan_create", {
  title: "Plan Create",
  description:
    "Create a plan with user story, ordered tasks, and test criteria. " +
    "Call BEFORE writing any code to establish intent and acceptance criteria.",
  inputSchema: PlanCreateSchema.shape,
}, tx("plan_create", (args) => handlePlanCreate(db, stmts, args)));

server.registerTool("plan_list", {
  title: "Plan List",
  description: "List plans with progress summary. Defaults to active plans.",
  inputSchema: PlanListSchema.shape,
}, tx("plan_list", (args) => handlePlanList(stmts, args)));

server.registerTool("plan_get", {
  title: "Plan Get",
  description: "Get full plan details: tasks, test criteria, status, and notes.",
  inputSchema: PlanGetSchema.shape,
}, tx("plan_get", (args) => handlePlanGet(stmts, args)));

server.registerTool("plan_update_task", {
  title: "Plan Update Task",
  description:
    "Update a task status. Auto-completes the plan when all tasks are done. " +
    "Statuses: pending → in_progress → done (or blocked).",
  inputSchema: PlanUpdateTaskSchema.shape,
}, tx("plan_update_task", (args) => handlePlanUpdateTask(stmts, args)));

// ---------------------------------------------------------------------------
// Tools — Updater
// ---------------------------------------------------------------------------

server.registerTool("update_lucid", {
  title: "Update Lucid",
  description:
    "Check for a newer version of Lucid on npm and update automatically. " +
    "Restart Claude Code after updating.",
  inputSchema: UpdateLucidSchema.shape,
}, tx("update_lucid", async (args) => handleUpdateLucid(args)));

// ---------------------------------------------------------------------------
// Tools — Web Dev Skills
// ---------------------------------------------------------------------------

server.registerTool("generate_component", {
  title: "Generate Component",
  description:
    "Generate a complete component scaffold from a description. React (TSX/JSX) or Vue/Nuxt. " +
    "Styling: Tailwind, CSS Modules, or none.",
  inputSchema: GenerateComponentSchema.shape,
}, tx("generate_component", (args) => handleGenerateComponent(args)));

server.registerTool("scaffold_page", {
  title: "Scaffold Page",
  description:
    "Generate a full page scaffold with layout, SEO head meta, and placeholder sections. " +
    "Nuxt (useHead), Next.js (Metadata API), or plain Vue.",
  inputSchema: ScaffoldPageSchema.shape,
}, tx("scaffold_page", (args) => handleScaffoldPage(args)));

server.registerTool("seo_meta", {
  title: "SEO Meta",
  description:
    "Generate complete SEO metadata: HTML meta tags, Open Graph, Twitter Card, JSON-LD " +
    "(Article, Product, WebSite, WebPage).",
  inputSchema: SeoMetaSchema.shape,
}, tx("seo_meta", (args) => handleSeoMeta(args)));

server.registerTool("accessibility_audit", {
  title: "Accessibility Audit",
  description:
    "Audit HTML/JSX/Vue snippets for WCAG violations. Checks: alt text, labels, empty buttons, " +
    "tabindex, click handlers, target=_blank. Returns severity + WCAG criterion + corrected code.",
  inputSchema: AccessibilityAuditSchema.shape,
}, tx("accessibility_audit", (args) => handleAccessibilityAudit(args)));

server.registerTool("api_client", {
  title: "API Client",
  description:
    "Generate a typed TypeScript async function for a REST endpoint. Includes types, " +
    "error handling (throws on non-2xx), usage example. Auth: bearer/cookie/apikey/none.",
  inputSchema: ApiClientSchema.shape,
}, tx("api_client", (args) => handleApiClient(args)));

server.registerTool("test_generator", {
  title: "Test Generator",
  description:
    "Generate a complete test file. Covers happy path, edge cases, error path, mock setup. " +
    "Frameworks: Vitest, Jest, Playwright. Component: Vue Test Utils or React Testing Library.",
  inputSchema: TestGeneratorSchema.shape,
}, tx("test_generator", (args) => handleTestGenerator(args)));

server.registerTool("responsive_layout", {
  title: "Responsive Layout",
  description:
    "Generate a responsive mobile-first layout from a wireframe description. " +
    "Tailwind utility classes, CSS Grid (named areas), or Flexbox + media queries.",
  inputSchema: ResponsiveLayoutSchema.shape,
}, tx("responsive_layout", (args) => handleResponsiveLayout(args)));

server.registerTool("security_scan", {
  title: "Security Scan",
  description:
    "Scan JS/TS/HTML/Vue for web security vulns: XSS, code injection, SQL injection, " +
    "hardcoded secrets, open redirects, prototype pollution, path traversal, insecure CORS. " +
    "Context-aware (frontend/backend/api).",
  inputSchema: SecurityScanSchema.shape,
}, tx("security_scan", (args) => handleSecurityScan(args)));

server.registerTool("design_tokens", {
  title: "Design Tokens",
  description:
    "Generate a complete design system token set from a brand color and mood. " +
    "11-step color scales, neutrals, semantic aliases, type/spacing/radius/shadow tokens. " +
    "Output: CSS vars, Tailwind config, or JSON.",
  inputSchema: DesignTokensSchema.shape,
}, tx("design_tokens", (args) => handleDesignTokens(args)));

server.registerTool("perf_hints", {
  title: "Perf Hints",
  description:
    "Analyze a component or page for Core Web Vitals issues. Detects LCP image priority, " +
    "CLS dimensions, render-blocking scripts, fetch-in-render, INP, missing memoization, " +
    "whole-library imports. Issues ranked by CWV metric impact.",
  inputSchema: PerfHintsSchema.shape,
}, tx("perf_hints", (args) => handlePerfHints(args)));

// ---------------------------------------------------------------------------
// Resources — read-only knowledge graph + config snapshots
// ---------------------------------------------------------------------------

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
      version: SERVER_VERSION,
      config: _appCfg,
      env: {
        MEMORY_DB_PATH: process.env["MEMORY_DB_PATH"] ?? null,
        QDRANT_URL: _qdrantUrl ?? null,
        EMBEDDING_URL: _embeddingUrl ?? null,
      },
    }, null, 2),
  }],
}));

// ---------------------------------------------------------------------------
// Prompts — reusable workflows the user can invoke as slash commands
// ---------------------------------------------------------------------------

server.registerPrompt("validate-changes", {
  title: "Validate recent changes",
  description: "Run the Logic Guardian 5-pass validation across files modified in the last N hours.",
  argsSchema: { hours: z.string().optional() },
}, ({ hours }) => {
  const h = hours ? Number(hours) : 24;
  return {
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Run Logic Guardian validation on every file modified in the last ${h} hours.\n\n` +
          `Steps:\n` +
          `1. Call \`get_recent\` with hours=${h} to list changed files.\n` +
          `2. For EACH file, call \`validate_file(path)\` and \`check_code_quality(path)\`.\n` +
          `3. Apply the 5-pass checklist from \`get_checklist\`.\n` +
          `4. Report: per-file findings + a single summary table (file × pass × issue count).\n` +
          `5. Stop and ask before fixing anything — report only.`,
      },
    }],
  };
});

server.registerPrompt("audit-file", {
  title: "Audit a single file",
  description: "Run the full Lucid audit pipeline (validate + drift + coding rules + security) on one file.",
  argsSchema: { path: z.string() },
}, ({ path }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text:
        `Audit \`${path}\` with the full Lucid pipeline:\n\n` +
        `1. \`validate_file(path="${path}")\` — Logic Guardian drift detection.\n` +
        `2. \`check_code_quality(path="${path}")\` — 25 Golden Rules.\n` +
        `3. Read the file content, then \`security_scan(code, language, context)\` if it's web code.\n` +
        `4. Apply the 5-pass checklist (\`get_checklist\`).\n` +
        `5. Report findings grouped by severity (high/medium/low). Do not fix yet.`,
    },
  }],
}));

server.registerPrompt("plan-feature", {
  title: "Plan a new feature",
  description: "Scaffold a Lucid plan from a feature description with tasks and test criteria.",
  argsSchema: { feature: z.string() },
}, ({ feature }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text:
        `Create a Lucid plan for this feature:\n\n"${feature}"\n\n` +
        `Steps:\n` +
        `1. Call \`smart_context(query="${feature}", task_type="moderate")\` to gather relevant files.\n` +
        `2. Draft a user story: "As a [user], I want [goal], so that [benefit]."\n` +
        `3. Break into 3–8 tasks. EACH task needs explicit \`test_criteria\` (how to verify done).\n` +
        `4. Call \`plan_create({title, description, user_story, tasks})\`.\n` +
        `5. Show the plan ID and the task list.`,
    },
  }],
}));

server.registerPrompt("security-review", {
  title: "Security review of recent changes",
  description: "Scan recently changed web code for XSS, injection, secrets, SSRF, and OWASP Top 10 patterns.",
  argsSchema: { hours: z.string().optional() },
}, ({ hours }) => {
  const h = hours ? Number(hours) : 24;
  return {
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Security review of files changed in the last ${h} hours.\n\n` +
          `1. Call \`get_recent\` with hours=${h}.\n` +
          `2. Filter to JS/TS/HTML/Vue files only.\n` +
          `3. For each, read content and call \`security_scan(code, language, context)\` ` +
          `with context inferred from the path (frontend/backend/api).\n` +
          `4. Report findings as a table: file × vuln class × severity × line.\n` +
          `5. Recommend fixes only after the report is complete.`,
      },
    }],
  };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[lucid] Server v${SERVER_VERSION} started on stdio (tools + resources + prompts).`);

// Non-blocking — logs to stderr if update is available
checkForUpdatesOnStartup().catch(() => {});
