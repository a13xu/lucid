import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// DB path — same as Lucid MCP
// ---------------------------------------------------------------------------
const dbPath = process.env["MEMORY_DB_PATH"] ?? join(homedir(), ".claude", "memory.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

console.error(`[web] DB: ${dbPath}`);

// ---------------------------------------------------------------------------
// New tables (plans + plan_tasks already exist from Lucid)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS test_definitions (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    method     TEXT NOT NULL DEFAULT 'GET',
    url        TEXT NOT NULL,
    headers    TEXT NOT NULL DEFAULT '{}',
    body       TEXT,
    assertions TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_td_task ON test_definitions(task_id);

  CREATE TABLE IF NOT EXISTS test_runs (
    id                INTEGER PRIMARY KEY,
    test_def_id       INTEGER NOT NULL REFERENCES test_definitions(id) ON DELETE CASCADE,
    status            TEXT NOT NULL,
    status_code       INTEGER,
    response_body     TEXT,
    response_headers  TEXT NOT NULL DEFAULT '{}',
    duration_ms       INTEGER,
    error_message     TEXT,
    assertions_result TEXT NOT NULL DEFAULT '[]',
    run_at            INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_tr_def ON test_runs(test_def_id, run_at DESC);
`);

// ---------------------------------------------------------------------------
// Row types (raw DB rows — JSON fields are strings)
// ---------------------------------------------------------------------------
export interface PlanRow {
  id: number;
  title: string;
  description: string;
  user_story: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface PlanWithStatsRow extends PlanRow {
  task_count: number;
  tasks_done: number;
}

export interface PlanTaskRow {
  id: number;
  plan_id: number;
  seq: number;
  title: string;
  description: string;
  test_criteria: string;
  status: string;
  notes: string; // JSON string
  created_at: number;
  updated_at: number;
}

export interface TestDefinitionRow {
  id: number;
  task_id: number;
  name: string;
  method: string;
  url: string;
  headers: string; // JSON string
  body: string | null;
  assertions: string; // JSON string
  created_at: number;
  updated_at: number;
}

export interface TestDefinitionWithLastRunRow extends TestDefinitionRow {
  last_run_status: string | null;
  last_run_at: number | null;
}

export interface TestRunRow {
  id: number;
  test_def_id: number;
  status: string;
  status_code: number | null;
  response_body: string | null;
  response_headers: string; // JSON string
  duration_ms: number | null;
  error_message: string | null;
  assertions_result: string; // JSON string
  run_at: number;
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
export const stmts = {
  // Plans (with task stats)
  getAllPlansWithStats: db.prepare(`
    SELECT p.*,
           COUNT(t.id) as task_count,
           SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as tasks_done
    FROM plans p
    LEFT JOIN plan_tasks t ON t.plan_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `),
  getPlansByStatusWithStats: db.prepare(`
    SELECT p.*,
           COUNT(t.id) as task_count,
           SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as tasks_done
    FROM plans p
    LEFT JOIN plan_tasks t ON t.plan_id = p.id
    WHERE p.status = ?
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `),
  getPlanById: db.prepare("SELECT * FROM plans WHERE id = ?"),
  insertPlan: db.prepare("INSERT INTO plans (title, description, user_story) VALUES (?, ?, ?)"),
  updatePlanStatus: db.prepare("UPDATE plans SET status = ?, updated_at = unixepoch() WHERE id = ?"),
  deletePlan: db.prepare("DELETE FROM plans WHERE id = ?"),

  // Tasks
  getTasksByPlanId: db.prepare("SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY seq"),
  getTaskById: db.prepare("SELECT * FROM plan_tasks WHERE id = ?"),
  insertPlanTask: db.prepare(
    "INSERT INTO plan_tasks (plan_id, seq, title, description, test_criteria) VALUES (?, ?, ?, ?, ?)"
  ),
  updateTaskStatus: db.prepare(
    "UPDATE plan_tasks SET status = ?, notes = ?, updated_at = unixepoch() WHERE id = ?"
  ),
  countRemainingTasks: db.prepare(
    "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status != 'done'"
  ),
  getTestCountsByPlanId: db.prepare(`
    SELECT task_id, COUNT(*) as count
    FROM test_definitions
    WHERE task_id IN (SELECT id FROM plan_tasks WHERE plan_id = ?)
    GROUP BY task_id
  `),

  // Test definitions
  getTestsByTaskId: db.prepare("SELECT * FROM test_definitions WHERE task_id = ? ORDER BY id"),
  getTestById: db.prepare("SELECT * FROM test_definitions WHERE id = ?"),
  getTestsWithLastRun: db.prepare(`
    SELECT td.*,
           tr.status as last_run_status,
           tr.run_at as last_run_at
    FROM test_definitions td
    LEFT JOIN test_runs tr ON tr.id = (
      SELECT id FROM test_runs WHERE test_def_id = td.id ORDER BY run_at DESC LIMIT 1
    )
    WHERE td.task_id = ?
    ORDER BY td.id
  `),
  insertTestDef: db.prepare(
    "INSERT INTO test_definitions (task_id, name, method, url, headers, body, assertions) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  updateTestDef: db.prepare(
    "UPDATE test_definitions SET name = ?, method = ?, url = ?, headers = ?, body = ?, assertions = ?, updated_at = unixepoch() WHERE id = ?"
  ),
  deleteTestDef: db.prepare("DELETE FROM test_definitions WHERE id = ?"),

  // Test runs
  insertTestRun: db.prepare(`
    INSERT INTO test_runs (test_def_id, status, status_code, response_body, response_headers, duration_ms, error_message, assertions_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRunsByTestDefId: db.prepare(
    "SELECT * FROM test_runs WHERE test_def_id = ? ORDER BY run_at DESC LIMIT 20"
  ),
};
