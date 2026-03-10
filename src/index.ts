#!/usr/bin/env node
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { initDatabase, prepareStatements } from "./database.js";
import { registerInstance, logAction } from "./instance.js";
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
import { handleRunE2eTest, RunE2eTestSchema } from "./tools/e2e.js";

// ---------------------------------------------------------------------------
// Init DB
// ---------------------------------------------------------------------------

const db = initDatabase();
const stmts = prepareStatements(db);
registerInstance(db);

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
  { name: "lucid", version: "1.10.0" },
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
        "Call BEFORE writing any code to establish intent and acceptance criteria. " +
        "An E2E verification task is automatically appended as the final task. " +
        "Use max_retries (default 3, range 1–10) to control how many times the E2E " +
        "remediation loop retries before giving up.",
      inputSchema: {
        type: "object",
        properties: {
          title:       { type: "string", description: "Short plan title." },
          description: { type: "string", description: "What this plan accomplishes." },
          user_story:  { type: "string", description: "As a [user], I want [goal], so that [benefit]." },
          max_retries: {
            type: "integer",
            description: "Maximum E2E remediation retries before the plan is marked e2e_failed. Default: 3. Min: 1. Max: 10.",
            minimum: 1,
            maximum: 10,
            default: 3,
          },
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
    {
      name: "run_e2e_test",
      description:
        "Run the E2E verification test for a plan's final E2E task. " +
        "Executes the task's test_criteria as a shell command, captures stdout/stderr, " +
        "and updates e2e_result ('pass'/'fail') and e2e_error in the database. " +
        "On pass, marks the task as done and auto-completes the plan if all tasks are done. " +
        "On fail, reports retries remaining based on the plan's max_retries setting.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "ID of the E2E task to run (from plan_get)." },
        },
        required: ["task_id"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const t0 = Date.now();

  // Security: rate limit + WAF check before any execution
  const guard = guardRequest(name, args);
  if (guard.blocked) {
    // Security block — do NOT log action
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
      case "plan_update_task": text = handlePlanUpdateTask(db, stmts, PlanUpdateTaskSchema.parse(args)); break;
      case "run_e2e_test":     text = handleRunE2eTest(db, stmts, RunE2eTestSchema.parse(args)); break;

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    // Security: scan output for sensitive data leakage
    logAction(db, name, args, true, Date.now() - t0);
    return { content: [{ type: "text", text: guardOutput(name, text) }] };
  } catch (err) {
    logAction(db, name, args, false, Date.now() - t0);
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

// Auto-start Web UI
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webServerPath = join(__dirname, "..", "web", "server.js");
const webProc = spawn(process.execPath, [webServerPath], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, PORT: "3069" },
});
webProc.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
    console.error("[lucid] Web UI failed to start:", err.message);
  }
});
webProc.unref();
console.error("[lucid] Web UI started on http://localhost:3069");
