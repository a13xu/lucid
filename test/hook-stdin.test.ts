import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

// These run the built scripts, because the bugs live in how a real process reads
// its stdin. `npm run build` first. A running `lucid watch` daemon would take the
// sync away from the sandbox database, so the sync tests skip while one is up.
const BUILD = join(import.meta.dirname, "..", "build");
const SPAWN_TIMEOUT_MS = 20_000;
const daemonUp = await fetch("http://localhost:7821/health", { signal: AbortSignal.timeout(500) })
  .then(() => true, () => false);

let dir: string;
let dbPath: string;
let source: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-hook-"));
  dbPath = join(dir, "memory.db");
  source = join(dir, "sample.ts");
  writeFileSync(source, "export const sample = 1;\n");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(script: string, args: string[], input: string) {
  return spawnSync(process.execPath, [join(BUILD, script), ...args], {
    input,
    encoding: "utf-8",
    env: { ...process.env, MEMORY_DB_PATH: dbPath },
    timeout: SPAWN_TIMEOUT_MS,
  });
}

function indexedSources(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT filepath FROM file_contents").all() as Array<{ filepath: string }>;
    return rows.map((r) => r.filepath).filter((f) => f.endsWith("sample.ts"));
  } finally {
    db.close();
  }
}

describe.skipIf(daemonUp)("lucid-sync", () => {
  it("indexes the file named in the hook payload", () => {
    const res = run("lucid-sync.js", [], JSON.stringify({ tool_name: "Write", tool_input: { file_path: source } }));
    expect(res.status).toBe(0);
    expect(indexedSources().length).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it("reads notebook_path for NotebookEdit", () => {
    const res = run("lucid-sync.js", [], JSON.stringify({ tool_name: "NotebookEdit", tool_input: { notebook_path: source } }));
    expect(res.status).toBe(0);
    expect(indexedSources().length).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it("falls back to the argument when stdin is empty or not JSON", () => {
    expect(run("lucid-sync.js", [source], "").status).toBe(0);
    expect(indexedSources().length).toBe(1);

    rmSync(dbPath, { force: true });
    expect(run("lucid-sync.js", [source], "not json").status).toBe(0);
    expect(indexedSources().length).toBe(1);
  }, SPAWN_TIMEOUT_MS * 2);
});

describe("lucid guard pre-edit", () => {
  it("snapshots a notebook before NotebookEdit changes it", () => {
    const res = run("index.js", ["guard", "pre-edit"], JSON.stringify({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: source, new_source: "x" },
    }));
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Snapshot stored");
    expect(res.stderr).not.toContain("No file path");
  }, SPAWN_TIMEOUT_MS);

  it("still allows a payload that names no file", () => {
    const res = run("index.js", ["guard", "pre-edit"], JSON.stringify({ tool_name: "Write", tool_input: {} }));
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("No file path");
  }, SPAWN_TIMEOUT_MS);
});
