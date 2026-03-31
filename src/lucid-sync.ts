#!/usr/bin/env node
/**
 * lucid-sync — PostToolUse hook script for Lucid.
 *
 * Called by Claude Code's PostToolUse hook after Write/Edit/NotebookEdit.
 * Reads tool input from stdin (JSON), extracts the modified file path,
 * then syncs it to Lucid's SQLite index.
 *
 * Fallback chain:
 *   1. POST http://localhost:7821/sync  (if lucid watch daemon is running)
 *   2. Direct SQLite write             (always works, no daemon needed)
 *
 * Never throws — hook failures must not interrupt Claude Code.
 */

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Parse file path from Claude Code hook stdin
// ---------------------------------------------------------------------------

interface HookInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    path?: string;
  };
}

function getFilePathFromStdin(): string | null {
  try {
    const raw = readFileSync("/dev/stdin", "utf-8").trim();
    if (!raw) return process.argv[2] ?? null;
    const data = JSON.parse(raw) as HookInput;
    const ti = data.tool_input ?? {};
    return ti.file_path ?? ti.notebook_path ?? ti.path ?? process.argv[2] ?? null;
  } catch {
    return process.argv[2] ?? null;
  }
}

// ---------------------------------------------------------------------------
// HTTP sync (fast — daemon must be running on port 7821)
// ---------------------------------------------------------------------------

async function tryHttpSync(filePath: string, port = 7821): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://localhost:${port}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Direct SQLite sync (fallback — always available)
// ---------------------------------------------------------------------------

async function syncDirect(filePath: string): Promise<void> {
  const { initDatabase, prepareStatements } = await import("./database.js");
  const { handleSyncFile } = await import("./tools/sync.js");
  const db = initDatabase();
  const stmts = prepareStatements(db);
  handleSyncFile(stmts, { path: filePath });
  db.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const filePath = getFilePathFromStdin();
  if (!filePath) return;

  const httpOk = await tryHttpSync(filePath);
  if (!httpOk) {
    await syncDirect(filePath);
  }
}

main().catch(() => {}); // never propagate errors to Claude Code
