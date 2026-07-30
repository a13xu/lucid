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
import {
  handleBackupFile, BackupFileSchema,
  handleRestoreFile, RestoreFileSchema,
  handleCheckTruncateRisk, CheckTruncateRiskSchema,
} from "./tools/backup.js";
import { handleSessionStatus, SessionStatusSchema } from "./tools/session.js";
import { backfillFileFts } from "./indexer/fts-backfill.js";
import {
  handleDelegateLocal, DelegateLocalSchema,
  handleLocalLlmStatus, LocalLlmStatusSchema,
} from "./tools/delegate-local.js";
import {
  handleIngestBook, IngestBookSchema,
  handleGenerateBookSkill, GenerateBookSkillSchema,
  handleListBooks, ListBooksSchema,
  runBookCli,
} from "./tools/book.js";
import { loadLocalConfig } from "./local-llm/config.js";

// ---------------------------------------------------------------------------
// CLI mode: lucid watch | lucid status | lucid stop
// ---------------------------------------------------------------------------

const [,, _cliCmd, ..._cliArgs] = process.argv;

if (_cliCmd === "watch" || _cliCmd === "status" || _cliCmd === "stop") {
  await runCli(_cliCmd, _cliArgs);
  process.exit(0);
}

if (_cliCmd === "guard") {
  const exitCode = await runGuardCli(_cliArgs);
  process.exit(exitCode);
}

if (_cliCmd === "session") {
  const exitCode = await runSessionCli(_cliArgs);
  process.exit(exitCode);
}

if (_cliCmd === "local") {
  const { runLocalLlmCli } = await import("./local-llm/setup-cli.js");
  const exitCode = await runLocalLlmCli(_cliArgs);
  process.exit(exitCode);
}

if (_cliCmd === "book") {
  const { initDatabase, prepareStatements } = await import("./database.js");
  const bookDb = initDatabase();
  const bookStmts = prepareStatements(bookDb);
  const exitCode = await runBookCli(_cliArgs, bookStmts);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// `lucid guard <subcmd>` — invoked from Claude Code hooks (PreToolUse, etc.)
//
// Subcommands:
//   pre-edit              Read PreToolUse JSON from stdin, snapshot the file,
//                         then assess truncate risk. Exit 2 = block (hard).
//   pre-edit --path P     Same, but path provided as flag (no stdin parse).
//   clear                 Clear cascade lock by purging recent truncate_events.
//   status                Show cascade-lock status + last events.
// ---------------------------------------------------------------------------

async function runGuardCli(args: string[]): Promise<number> {
  const sub = args[0];
  const { initDatabase, prepareStatements } = await import("./database.js");
  const db = initDatabase();
  const stmts = prepareStatements(db);

  if (sub === "clear") {
    db.exec("DELETE FROM truncate_events");
    process.stderr.write("[Lucid guard] Cascade lock cleared.\n");
    return 0;
  }

  if (sub === "status") {
    const { isCascadeBlocked, TUNABLES } = await import("./guardian/truncate-guard.js");
    const cascade = isCascadeBlocked(stmts);
    const since = Math.floor(Date.now() / 1000) - TUNABLES.CASCADE_WINDOW_SECONDS;
    const events = stmts.recentTruncateEvents.all(since);
    process.stdout.write(
      `Cascade locked: ${cascade.blocked} (${cascade.count}/${TUNABLES.CASCADE_THRESHOLD} ` +
      `within ${TUNABLES.CASCADE_WINDOW_SECONDS}s)\n`
    );
    for (const e of events) {
      process.stdout.write(
        `  ${new Date(e.created_at * 1000).toISOString()} ` +
        `${e.filepath} ${e.prev_size}B→${e.new_size}B (${(e.shrink_ratio * 100).toFixed(0)}%)\n`
      );
    }
    return 0;
  }

  if (sub === "pre-edit") {
    return await guardPreEdit(stmts, args.slice(1));
  }

  process.stderr.write(`Usage: lucid guard <pre-edit|clear|status>\n`);
  return 64; // EX_USAGE
}

interface HookPayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
    content?: string;
    new_string?: string;
    edits?: Array<{ old_string?: string; new_string?: string }>;
  };
}

async function guardPreEdit(
  stmts: import("./database.js").Statements,
  flagArgs: string[],
): Promise<number> {
  const { backupFile, assessTruncate, recordTruncateEvent } =
    await import("./guardian/truncate-guard.js");

  // Override switch — never blocks. Useful for one-off legitimate truncates.
  if (process.env["LUCID_TRUNCATE_OVERRIDE"] === "1") return 0;

  const pathFlagIdx = flagArgs.indexOf("--path");
  let path = pathFlagIdx >= 0 ? flagArgs[pathFlagIdx + 1] : undefined;
  let content: string | null = null;
  let toolName = "Write";

  // Try parsing PreToolUse JSON from stdin (Claude Code hook protocol).
  // Skip stdin read when --path is given OR when stdin is a TTY (manual run).
  if (!path && !process.stdin.isTTY) {
    const raw = await readStdin();
    if (raw.trim()) {
      try {
        const payload = JSON.parse(raw) as HookPayload;
        toolName = payload.tool_name ?? "Write";
        const ti = payload.tool_input ?? {};
        path = ti.file_path ?? ti.path;
        // Only `Write` carries the full new file content. `Edit`/`MultiEdit`
        // carry replacement fragments, not the full post-write state — assessing
        // shrinkage on those produces false MAJOR_SHRINK blocks on every edit
        // of a non-tiny file. Leave content=null so assessTruncate skips the
        // size-based rules and only the cascade lock can apply.
        if (toolName === "Write" && typeof ti.content === "string") {
          content = ti.content;
        }
      } catch {
        // Non-JSON stdin — ignore, fall through to "no path" error.
      }
    }
  }

  if (!path) {
    process.stderr.write("[Lucid guard] No file path in hook input — allowing.\n");
    return 0;
  }

  // Snapshot BEFORE assessing — even if we end up blocking, we want the version
  // that's about to be overwritten safely stored.
  const snap = backupFile(stmts, path, `pre-${toolName.toLowerCase()}`);
  if (snap.saved) {
    process.stderr.write(`[Lucid guard] 📸 Snapshot stored for ${path}\n`);
  }

  const verdict = assessTruncate(path, content, stmts);
  if (!verdict.blocked) return 0;

  recordTruncateEvent(stmts, path, verdict.prevSize, verdict.newSize, true);

  // Exit code 2 → Claude Code blocks the tool call and surfaces stderr.
  process.stderr.write(
    `🛑 [Lucid guard] BLOCK [${verdict.rule}] ${path}\n` +
    `   ${verdict.reason}\n` +
    (verdict.cascade
      ? `   Override: set LUCID_TRUNCATE_OVERRIDE=1 or run "lucid guard clear".\n`
      : `   prev=${verdict.prevSize}B new=${verdict.newSize}B keep=${(verdict.shrinkRatio * 100).toFixed(0)}%\n` +
        `   Restore via: restore_file(path="${path}")\n`)
  );
  return 2;
}

// ---------------------------------------------------------------------------
// `lucid session <subcmd>` — invoked from UserPromptSubmit & PreCompact hooks.
//
// Subcommands:
//   tick           Read UserPromptSubmit JSON from stdin → emit hints to stdout
//                  (Claude Code injects stdout as additional context).
//   compact        Read PreCompact JSON from stdin → reset session counters.
//   status         Print recent sessions + active hint thresholds.
//   reset [--id S] Reset a single session counter (or the latest if no --id).
// ---------------------------------------------------------------------------

async function runSessionCli(args: string[]): Promise<number> {
  const sub = args[0];
  const { initDatabase, prepareStatements } = await import("./database.js");
  const db = initDatabase();
  const stmts = prepareStatements(db);

  if (sub === "tick")    return await sessionTickCli(stmts);
  if (sub === "compact") return await sessionCompactCli(stmts);
  if (sub === "status") {
    const { handleSessionStatus } = await import("./tools/session.js");
    process.stdout.write(handleSessionStatus(stmts, { limit: 10 }) + "\n");
    return 0;
  }
  if (sub === "reset") {
    const idIdx = args.indexOf("--id");
    if (idIdx >= 0 && args[idIdx + 1]) {
      stmts.resetCliSessionCount.run(args[idIdx + 1]!);
      process.stderr.write(`[Lucid session] Reset counters for ${args[idIdx + 1]}\n`);
    } else {
      const recent = stmts.recentCliSessions.all(1);
      if (recent.length === 0) { process.stderr.write("No sessions tracked.\n"); return 0; }
      stmts.resetCliSessionCount.run(recent[0]!.session_id);
      process.stderr.write(`[Lucid session] Reset counters for ${recent[0]!.session_id}\n`);
    }
    return 0;
  }

  process.stderr.write(`Usage: lucid session <tick|compact|status|reset>\n`);
  return 64;
}

interface SessionHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

async function sessionTickCli(
  stmts: import("./database.js").Statements,
): Promise<number> {
  const { tickSession } = await import("./guardian/session-tracker.js");
  const payload = await readHookPayload<SessionHookPayload>();
  const sid = payload?.session_id ?? "unknown-session";
  const cwd = payload?.cwd ?? null;

  const result = tickSession(stmts, sid, cwd);

  // Emit hints to stdout — Claude Code injects them as additional context.
  for (const h of result.hints) process.stdout.write(h + "\n");
  return 0;
}

async function sessionCompactCli(
  stmts: import("./database.js").Statements,
): Promise<number> {
  const { markCompactEvent } = await import("./guardian/session-tracker.js");
  const payload = await readHookPayload<SessionHookPayload>();
  const sid = payload?.session_id ?? "unknown-session";
  markCompactEvent(stmts, sid);
  process.stderr.write(`[Lucid session] /compact recorded — counters reset for ${sid}\n`);
  return 0;
}

async function readHookPayload<T>(): Promise<T | null> {
  if (process.stdin.isTTY) return null;
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function readStdin(): Promise<string> {
  return new Promise((resolveStdin) => {
    let buf = "";
    const timer = setTimeout(() => resolveStdin(buf), 250);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => { clearTimeout(timer); resolveStdin(buf); });
    process.stdin.on("error", () => { clearTimeout(timer); resolveStdin(buf); });
  });
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
allowHost("https://registry.npmjs.org");

// Local-LLM endpoint (may be remote — user-opted-in via `lucid local init`)
const _localCfg = loadLocalConfig();
if (_localCfg?.enabled) {
  try { allowHost(_localCfg.endpoint); } catch { /* ignore */ }
}

// FTS5 backfill for DBs indexed before file_text_fts existed (chunked, non-blocking)
backfillFileFts(stmts);

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
// Tools — Local LLM (Ollama / LM Studio / llama.cpp / remote endpoint)
// ---------------------------------------------------------------------------

server.registerTool("delegate_local", {
  title: "Delegate to Local LLM",
  description:
    "Send a prompt to the user-configured local LLM (Ollama / LM Studio / llama.cpp / remote " +
    "endpoint). Returns the raw completion. Configure once via `lucid local init`. Best for " +
    "small specialized tasks (docstrings, type hints, simple refactors, regex). Claude should " +
    "review the output before applying it via Edit/Write.",
  inputSchema: DelegateLocalSchema.shape,
}, tx("delegate_local", async (args) => handleDelegateLocal(args)));

server.registerTool("local_llm_status", {
  title: "Local LLM Status",
  description:
    "Inspect the local-LLM configuration: runtime, endpoint, model, reachability. " +
    "Returns setup instructions if not yet configured.",
  inputSchema: LocalLlmStatusSchema.shape,
}, tx("local_llm_status", async () => handleLocalLlmStatus()));

// ---------------------------------------------------------------------------
// Tools — Session Cost Tracker
// ---------------------------------------------------------------------------

server.registerTool("session_status", {
  title: "Session Status",
  description:
    "Show recent Claude Code sessions with prompt counts, idle time, and /compact " +
    "history. Use to inspect when /compact or /clear hints are about to fire.",
  inputSchema: SessionStatusSchema.shape,
}, tx("session_status", (args) => handleSessionStatus(stmts, args)));

// ---------------------------------------------------------------------------
// Tools — Backup & Truncate Guard
// ---------------------------------------------------------------------------

server.registerTool("backup_file", {
  title: "Backup File",
  description:
    "Snapshot the current on-disk content of a file into Lucid's versioned backup store " +
    "(zlib-compressed, last 10 versions kept). Use before risky edits.",
  inputSchema: BackupFileSchema.shape,
}, tx("backup_file", (args) => handleBackupFile(stmts, args)));

server.registerTool("restore_file", {
  title: "Restore File",
  description:
    "Restore a file from a previous Lucid backup. version=1 is the latest snapshot, " +
    "2 is the one before, etc. Pass dry_run=true to preview without writing.",
  inputSchema: RestoreFileSchema.shape,
}, tx("restore_file", (args) => handleRestoreFile(stmts, args)));

server.registerTool("check_truncate_risk", {
  title: "Check Truncate Risk",
  description:
    "Assess whether writing new_content (or new_size) to path would constitute a destructive " +
    "truncate (empty/whitespace overwrite, >70% shrink, or active cascade lock). Read-only by default.",
  inputSchema: CheckTruncateRiskSchema.shape,
}, tx("check_truncate_risk", (args) => handleCheckTruncateRisk(stmts, args)));

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
// Tools — Book Ingestion (PDF/EPUB/DOCX → markdown chunks → skill router)
// ---------------------------------------------------------------------------

server.registerTool("ingest_book", {
  title: "Ingest Book",
  description:
    "Convert a book (PDF, EPUB, DOCX, or Markdown) into chunked markdown files " +
    "under ./books/<slug>/ and index every chunk into Lucid. Requires user-installed " +
    "converter (pymupdf4llm for PDF, pandoc for EPUB/DOCX). Pair with generate_book_skill " +
    "to make the corpus auto-load as a Claude Code skill.",
  inputSchema: IngestBookSchema.shape,
}, tx("ingest_book", (args) => handleIngestBook(stmts, args)));

server.registerTool("generate_book_skill", {
  title: "Generate Book Skill",
  description:
    "Emit a thin SKILL.md router into ~/.claude/skills/book-<slug>/ (or .claude/skills/ " +
    "for project scope). The skill auto-loads (~100 tokens) when its trigger topics come up " +
    "and delegates retrieval to smart_context. Run after ingest_book.",
  inputSchema: GenerateBookSkillSchema.shape,
}, tx("generate_book_skill", (args) => handleGenerateBookSkill(args)));

server.registerTool("list_books", {
  title: "List Books",
  description: "List ingested books under ./books/ with chunk counts and ingestion dates.",
  inputSchema: ListBooksSchema.shape,
}, tx("list_books", (args) => handleListBooks(args)));

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
