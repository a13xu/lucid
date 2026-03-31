#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

// Register Qdrant host in SSRF allowlist if configured
const _qdrantUrl = process.env["QDRANT_URL"] ?? _appCfg.qdrant?.url;
if (_qdrantUrl) {
  try { allowHost(_qdrantUrl); } catch { /* ignore invalid URL */ }
}
const _embeddingUrl = process.env["EMBEDDING_URL"] ?? _appCfg.qdrant?.embeddingUrl;
if (_embeddingUrl) {
  try { allowHost(_embeddingUrl); } catch { /* ignore */ }
} else {
  // Default embedding endpoint
  allowHost("https://api.openai.com");
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "lucid", version: "1.13.0" },
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
          language: { type: "string", enum: ["python", "javascript", "typescript", "vue", "generic"], description: "Filter by language." },
          context:  { type: "number", description: "Lines of context before/after each match (0-10, default 2)." },
        },
        required: ["pattern"],
      },
    },
    // ── Context & Token Optimization ─────────────────────────────────────────
    {
      name: "get_context",
      description:
        "Retrieve the minimal relevant context for a task or query. " +
        "Uses TF-IDF scoring (or Qdrant vector search if configured) to rank files by relevance, " +
        "applies recency boost for recently modified files, and returns skeletons (signatures only) " +
        "for large files to stay within the token budget. " +
        "Configure limits in lucid.config.json. Set QDRANT_URL env var for vector search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you are working on or searching for" },
          maxTokens: { type: "number", description: "Total token budget (default 4000)" },
          dirs: { type: "array", items: { type: "string" }, description: "Whitelist directories (e.g. [\"src\", \"backend\"])" },
          recentOnly: { type: "boolean", description: "Only files modified within recentWindowHours" },
          recentHours: { type: "number", description: "Override recent window (hours)" },
          skeletonOnly: { type: "boolean", description: "Always show skeleton (signatures only)" },
          topK: { type: "number", description: "Max files to consider (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_recent",
      description:
        "Return files modified recently with line-level diffs. " +
        "Shows what changed in each file since the previous sync. " +
        "Useful for catching up after a git pull or resuming a session.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Look back N hours (default 24)" },
          withDiffs: { type: "boolean", description: "Include line diffs (default true)" },
        },
      },
    },
    // ── Smart Context + Model Advisor ─────────────────────────────────────────
    {
      name: "smart_context",
      description:
        "Combined: knowledge graph (recall) + code files (get_context) in one call. " +
        "Use instead of calling recall() + get_context() separately. " +
        "task_type adjusts token budget: simple=2000, moderate=6000, complex=12000. " +
        "Logs an experience so reward()/penalize() work after this call.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you are working on" },
          task_type: {
            type: "string",
            enum: ["simple", "moderate", "complex"],
            description: "Token budget: simple=2000, moderate=6000 (default), complex=12000",
          },
          dirs: {
            type: "array",
            items: { type: "string" },
            description: "Whitelist directories (e.g. [\"src\", \"backend\"])",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "suggest_model",
      description:
        "Classify task complexity → recommend Claude model. " +
        "Returns { model, model_id, reasoning, context_budget }. " +
        "Call at the start of any workflow. Simple lookups → Haiku; everything else → Sonnet (default).",
      inputSchema: {
        type: "object",
        properties: {
          task_description: {
            type: "string",
            description: "Natural language description of the task you are about to perform",
          },
        },
        required: ["task_description"],
      },
    },
    // ── Reward System ────────────────────────────────────────────────────────
    {
      name: "reward",
      description:
        "Signal that the last get_context() result was helpful (+1 reward). " +
        "The files returned in that context will be ranked higher in future similar queries. " +
        "Call this after a get_context() result led to a correct fix or useful code.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "Optional note about what worked (stored for future reference)" },
        },
      },
    },
    {
      name: "penalize",
      description:
        "Signal that the last get_context() result was unhelpful (-1 reward). " +
        "The files returned in that context will be ranked lower in future similar queries. " +
        "Call this after a get_context() result missed important files or was irrelevant.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "Optional note about what was missing or wrong" },
        },
      },
    },
    {
      name: "show_rewards",
      description:
        "Show the top rewarded experiences and most rewarded files. " +
        "Rewards decay exponentially (half-life ~14 days). " +
        "Use this to understand which context queries and files have been most valuable.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Filter experiences by query text (optional)" },
          topK: { type: "number", description: "Number of top results to show (default 10)" },
        },
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
    // ── Coding Guard ─────────────────────────────────────────────────────────
    {
      name: "coding_rules",
      description:
        "Get the 25 Golden Rules coding checklist. Covers clarity, naming, single responsibility, " +
        "error handling, frontend component size/reuse/props, singleton rules, library selection, " +
        "and architecture separation. Review before marking any task done.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "check_code_quality",
      description:
        "Analyze a file or code snippet against the 25 Golden Rules. " +
        "Detects: file/function size violations, vague naming, deep nesting, dead code, and — " +
        "for React/Vue component files — inline styles, prop explosion, fetch-in-component, " +
        "direct DOM access, mixed styling systems. " +
        "Complements validate_file (which checks logic correctness).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file to analyze." },
          code: { type: "string", description: "Code snippet to analyze inline." },
          language: {
            type: "string",
            enum: ["python", "javascript", "typescript", "vue", "generic"],
            description: "Language hint. Auto-detected from file extension if path is provided.",
          },
        },
      },
    },
    // ── Planning ─────────────────────────────────────────────────────────────
    {
      name: "plan_create",
      description:
        "Create a plan with user story, ordered tasks, and test criteria. " +
        "Call BEFORE writing any code to establish intent and acceptance criteria.",
      inputSchema: {
        type: "object",
        properties: {
          title:       { type: "string", description: "Short plan title." },
          description: { type: "string", description: "What this plan accomplishes." },
          user_story:  { type: "string", description: "As a [user], I want [goal], so that [benefit]." },
          tasks: {
            type: "array",
            description: "Ordered list of implementation tasks (1–20).",
            items: {
              type: "object",
              properties: {
                title:         { type: "string" },
                description:   { type: "string" },
                test_criteria: { type: "string", description: "How to verify this task is done." },
              },
              required: ["title", "description", "test_criteria"],
            },
            minItems: 1,
            maxItems: 20,
          },
        },
        required: ["title", "description", "user_story", "tasks"],
      },
    },
    {
      name: "plan_list",
      description: "List plans with progress summary. Defaults to active plans.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "completed", "abandoned", "all"],
            description: "Filter by plan status (default: active).",
          },
        },
      },
    },
    {
      name: "plan_get",
      description: "Get full plan details: tasks, test criteria, status, and notes.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: { type: "number", description: "Plan ID from plan_create or plan_list." },
        },
        required: ["plan_id"],
      },
    },
    {
      name: "plan_update_task",
      description:
        "Update a task status. Auto-completes the plan when all tasks are done. " +
        "Statuses: pending → in_progress → done (or blocked).",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID from plan_get." },
          status:  { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
          note:    { type: "string", description: "Optional note appended to task history." },
        },
        required: ["task_id", "status"],
      },
    },
    // ── Updater ──────────────────────────────────────────────────────────────
    {
      name: "update_lucid",
      description:
        "Check for a newer version of Lucid on npm and update automatically. " +
        "For global npm installs: runs npm install -g @a13xu/lucid@latest. " +
        "For local source installs: shows git pull + npm run build instructions. " +
        "After updating, restart Claude Code to load the new version.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Force reinstall even if already on latest version (default false)",
          },
        },
      },
    },
    // ── Web Dev Skills ───────────────────────────────────────────────────────
    {
      name: "generate_component",
      description:
        "Generate a complete component scaffold from a natural language description. " +
        "Supports React (TSX/JSX) and Vue/Nuxt (Composition API + <script setup>). " +
        "Styling options: Tailwind CSS, CSS Modules, or none.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Natural language description of the component" },
          framework:   { type: "string", enum: ["react", "vue", "nuxt"], description: "Target framework" },
          styling:     { type: "string", enum: ["tailwind", "css-modules", "none"], description: "Styling approach" },
          typescript:  { type: "boolean", description: "Whether to use TypeScript" },
        },
        required: ["description", "framework", "styling", "typescript"],
      },
    },
    {
      name: "scaffold_page",
      description:
        "Generate a full page scaffold with layout, SEO head meta, and placeholder sections. " +
        "Supports Nuxt (useHead), Next.js (Metadata API), and plain Vue.",
      inputSchema: {
        type: "object",
        properties: {
          page_name:  { type: "string", description: "Page name (e.g. About, Dashboard)" },
          framework:  { type: "string", enum: ["nuxt", "next", "vue"], description: "Target framework" },
          sections:   { type: "array", items: { type: "string" }, description: "Section names (e.g. hero, features, footer)" },
          seo_title:  { type: "string", description: "Optional SEO title" },
        },
        required: ["page_name", "framework", "sections"],
      },
    },
    {
      name: "seo_meta",
      description:
        "Generate complete SEO metadata for a page: HTML meta tags, Open Graph, Twitter Card, " +
        "and JSON-LD structured data (Article, Product, WebSite, or WebPage).",
      inputSchema: {
        type: "object",
        properties: {
          title:       { type: "string", description: "Page title" },
          description: { type: "string", description: "Meta description (≤160 chars recommended)" },
          keywords:    { type: "array", items: { type: "string" }, description: "SEO keywords" },
          page_type:   { type: "string", enum: ["article", "product", "landing", "home"], description: "Page type for JSON-LD" },
          url:         { type: "string", description: "Canonical page URL" },
          image_url:   { type: "string", description: "OG/Twitter image URL" },
        },
        required: ["title", "description", "keywords", "page_type"],
      },
    },
    {
      name: "accessibility_audit",
      description:
        "Audit HTML, JSX, or Vue template snippets for WCAG accessibility violations. " +
        "Checks: missing alt text, unlabeled inputs, empty buttons/links, positive tabindex, " +
        "non-interactive click handlers, open-in-new-tab links, and more. " +
        "Returns severity (critical/warning/info), WCAG criterion, and corrected code.",
      inputSchema: {
        type: "object",
        properties: {
          code:        { type: "string", description: "HTML, JSX, or Vue snippet to audit" },
          wcag_level:  { type: "string", enum: ["A", "AA", "AAA"], description: "WCAG conformance level" },
          framework:   { type: "string", enum: ["html", "jsx", "vue"], description: "Code framework" },
        },
        required: ["code", "wcag_level", "framework"],
      },
    },
    {
      name: "api_client",
      description:
        "Generate a typed TypeScript async function for a REST API endpoint. " +
        "Includes full types, error handling (throws on non-2xx), and a usage example. " +
        "Auth strategies: Bearer token, cookie, API key, or none.",
      inputSchema: {
        type: "object",
        properties: {
          endpoint:        { type: "string", description: "API endpoint path (e.g. /users/:id)" },
          method:          { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          request_schema:  { type: "string", description: "TypeScript type for request body" },
          response_schema: { type: "string", description: "TypeScript type for response" },
          auth:            { type: "string", enum: ["bearer", "cookie", "apikey", "none"] },
          base_url_var:    { type: "string", description: "Env var name for base URL (e.g. NEXT_PUBLIC_API_URL)" },
        },
        required: ["endpoint", "method", "auth"],
      },
    },
    {
      name: "test_generator",
      description:
        "Generate a complete test file for a function, component, or API handler. " +
        "Covers: happy path, edge cases (empty/null/boundary), error path, and mock setup. " +
        "Frameworks: Vitest, Jest, or Playwright (e2e). " +
        "Component testing: Vue Test Utils or React Testing Library.",
      inputSchema: {
        type: "object",
        properties: {
          code:               { type: "string", description: "Source code to generate tests for" },
          test_framework:     { type: "string", enum: ["vitest", "jest", "playwright"] },
          test_type:          { type: "string", enum: ["unit", "integration", "e2e"] },
          component_framework: { type: "string", enum: ["vue", "react", "none"] },
        },
        required: ["code", "test_framework", "test_type"],
      },
    },
    {
      name: "responsive_layout",
      description:
        "Generate a responsive mobile-first layout from a wireframe description. " +
        "Outputs: Tailwind CSS utility classes, CSS Grid with named areas, or Flexbox with media queries. " +
        "Container types: full-width, centered max-width, or sidebar layout.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Wireframe description (e.g. 'sidebar + main + right panel')" },
          framework:   { type: "string", enum: ["tailwind", "css-grid", "flexbox"] },
          breakpoints: { type: "array", items: { type: "string" }, description: "Breakpoint names (e.g. ['mobile', 'tablet', 'desktop'])" },
          container:   { type: "string", enum: ["full", "centered", "sidebar"] },
        },
        required: ["description", "framework", "breakpoints"],
      },
    },
    {
      name: "security_scan",
      description:
        "Scan JavaScript/TypeScript/HTML/Vue code for common web security vulnerabilities. " +
        "Detects: XSS (innerHTML, v-html, dangerouslySetInnerHTML), code injection (eval, new Function), " +
        "SQL injection, hardcoded secrets, open redirects, prototype pollution, path traversal, " +
        "render-blocking scripts, and insecure CORS. Context-aware: frontend vs backend vs API rules. " +
        "Complements validate_file (logic drift) — this focuses on web security patterns.",
      inputSchema: {
        type: "object",
        properties: {
          code:     { type: "string", description: "Code snippet to scan" },
          language: { type: "string", enum: ["javascript", "typescript", "html", "vue"] },
          context:  { type: "string", enum: ["frontend", "backend", "api"] },
        },
        required: ["code", "language", "context"],
      },
    },
    {
      name: "design_tokens",
      description:
        "Generate a complete design system token set from a brand color and mood. " +
        "Produces: 11-step color scales (50–950), neutral scale, semantic color aliases, " +
        "typography scale, spacing, border-radius, and shadow tokens. " +
        "Output formats: CSS custom properties, Tailwind config, or JSON.",
      inputSchema: {
        type: "object",
        properties: {
          brand_name:    { type: "string", description: "Brand or project name" },
          primary_color: { type: "string", description: "Primary color as hex (#3B82F6) or name (blue)" },
          mood:          { type: "string", enum: ["minimal", "bold", "playful", "corporate"] },
          output_format: { type: "string", enum: ["css-variables", "tailwind-config", "json"] },
        },
        required: ["brand_name", "primary_color", "mood", "output_format"],
      },
    },
    {
      name: "perf_hints",
      description:
        "Analyze a component or page file for Core Web Vitals (CWV) and web performance issues. " +
        "Detects: missing LCP image priority, images without dimensions (CLS), render-blocking scripts, " +
        "fetch-in-render (TTFB), heavy click handlers (INP), missing useMemo/computed, " +
        "whole-library imports, and inline style objects. Issues ranked by CWV metric impact.",
      inputSchema: {
        type: "object",
        properties: {
          code:      { type: "string", description: "Component or page source code to analyze" },
          framework: { type: "string", enum: ["react", "vue", "nuxt", "vanilla"] },
          context:   { type: "string", enum: ["component", "page", "layout"] },
        },
        required: ["code", "framework", "context"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Security: rate limit + WAF check before any execution
  const guard = guardRequest(name, args);
  if (guard.blocked) {
    return { content: [{ type: "text", text: guard.reason ?? "Request blocked by security guard" }], isError: true };
  }

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
      case "init_project":  text = await handleInitProject(stmts, InitProjectSchema.parse(args)); break;
      case "sync_file":     text = handleSyncFile(stmts, SyncFileSchema.parse(args)); break;
      case "sync_project":  text = handleSyncProject(stmts, SyncProjectSchema.parse(args)); break;

      // Grep
      case "grep_code":     text = handleGrepCode(stmts, GrepCodeSchema.parse(args)); break;

      // Context & Token Optimization
      case "get_context":   text = await handleGetContext(stmts, GetContextSchema.parse(args)); break;
      case "get_recent":    text = handleGetRecent(stmts, GetRecentSchema.parse(args)); break;

      // Smart Context + Model Advisor
      case "smart_context":  text = await handleSmartContext(stmts, SmartContextSchema.parse(args)); break;
      case "suggest_model":  text = handleSuggestModel(SuggestModelSchema.parse(args)); break;

      // Reward System
      case "reward":        text = handleReward(stmts, RewardSchema.parse(args)); break;
      case "penalize":      text = handlePenalize(stmts, PenalizeSchema.parse(args)); break;
      case "show_rewards":  text = handleShowRewards(stmts, ShowRewardsSchema.parse(args)); break;

      // Logic Guardian
      case "validate_file": text = handleValidateFile(ValidateFileSchema.parse(args)); break;
      case "check_drift":   text = handleCheckDrift(CheckDriftSchema.parse(args)); break;
      case "get_checklist": text = handleGetChecklist(); break;

      // Coding Guard
      case "coding_rules":       text = handleGetCodingRules(); break;
      case "check_code_quality": text = handleCheckCodeQuality(CheckCodeQualitySchema.parse(args)); break;

      // Planning
      case "plan_create":      text = handlePlanCreate(db, stmts, PlanCreateSchema.parse(args)); break;
      case "plan_list":        text = handlePlanList(stmts, PlanListSchema.parse(args)); break;
      case "plan_get":         text = handlePlanGet(stmts, PlanGetSchema.parse(args)); break;
      case "plan_update_task": text = handlePlanUpdateTask(stmts, PlanUpdateTaskSchema.parse(args)); break;

      // Updater
      case "update_lucid": text = await handleUpdateLucid(UpdateLucidSchema.parse(args)); break;

      // Web Dev Skills
      case "generate_component":   text = handleGenerateComponent(GenerateComponentSchema.parse(args)); break;
      case "scaffold_page":        text = handleScaffoldPage(ScaffoldPageSchema.parse(args)); break;
      case "seo_meta":             text = handleSeoMeta(SeoMetaSchema.parse(args)); break;
      case "accessibility_audit":  text = handleAccessibilityAudit(AccessibilityAuditSchema.parse(args)); break;
      case "api_client":           text = handleApiClient(ApiClientSchema.parse(args)); break;
      case "test_generator":       text = handleTestGenerator(TestGeneratorSchema.parse(args)); break;
      case "responsive_layout":    text = handleResponsiveLayout(ResponsiveLayoutSchema.parse(args)); break;
      case "security_scan":        text = handleSecurityScan(SecurityScanSchema.parse(args)); break;
      case "design_tokens":        text = handleDesignTokens(DesignTokensSchema.parse(args)); break;
      case "perf_hints":           text = handlePerfHints(PerfHintsSchema.parse(args)); break;

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    // Security: scan output for sensitive data leakage
    return { content: [{ type: "text", text: guardOutput(name, text) }] };
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
console.error(`[lucid] Server v${getCurrentVersion()} started on stdio.`);

// Non-blocking — logs to stderr if update is available
checkForUpdatesOnStartup().catch(() => {});
