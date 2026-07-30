// ---------------------------------------------------------------------------
// CLI mode dispatch: lucid watch | status | stop | guard | session | local | book
//
// maybeRunCli() returns an exit code when argv selected a CLI command, or
// null when the process should continue as an MCP stdio server.
// ---------------------------------------------------------------------------

export async function maybeRunCli(argv: string[]): Promise<number | null> {
  const [, , cmd, ...args] = argv;

  if (cmd === "watch" || cmd === "status" || cmd === "stop") {
    await runCli(cmd, args);
    return 0;
  }
  if (cmd === "guard") return await runGuardCli(args);
  if (cmd === "session") return await runSessionCli(args);
  if (cmd === "local") {
    const { runLocalLlmCli } = await import("./local-llm/setup-cli.js");
    return await runLocalLlmCli(args);
  }
  if (cmd === "book") {
    const { initDatabase, prepareStatements } = await import("./database.js");
    const { runBookCli } = await import("./tools/book.js");
    const bookDb = initDatabase();
    const bookStmts = prepareStatements(bookDb);
    return await runBookCli(args, bookStmts);
  }
  return null;
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

// ---------------------------------------------------------------------------
// `lucid watch` daemon + status/stop
// ---------------------------------------------------------------------------

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
