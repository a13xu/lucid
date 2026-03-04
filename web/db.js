import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

const dbPath = process.env["MEMORY_DB_PATH"] ?? join(homedir(), ".claude", "memory.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

console.error(`[web] DB: ${dbPath}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    user_story  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

  CREATE TABLE IF NOT EXISTS plan_tasks (
    id            INTEGER PRIMARY KEY,
    plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    test_criteria TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    notes         TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id, seq);

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

  CREATE TABLE IF NOT EXISTS instances (
    instance_id    TEXT PRIMARY KEY,
    pid            INTEGER NOT NULL,
    label          TEXT NOT NULL DEFAULT '',
    started_at     INTEGER DEFAULT (unixepoch()),
    last_heartbeat INTEGER DEFAULT (unixepoch()),
    status         TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS instance_actions (
    id           INTEGER PRIMARY KEY,
    instance_id  TEXT NOT NULL,
    tool_name    TEXT NOT NULL,
    args_json    TEXT NOT NULL DEFAULT '{}',
    result_ok    INTEGER NOT NULL DEFAULT 1,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_ia_instance ON instance_actions(instance_id, created_at DESC);
`);

// Migration: add instance_id to plans if not exists
try {
  db.exec("ALTER TABLE plans ADD COLUMN instance_id TEXT");
} catch (e) {
  if (!e.message.includes("duplicate column name")) throw e;
}

export const stmts = {
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

  insertTestRun: db.prepare(`
    INSERT INTO test_runs (test_def_id, status, status_code, response_body, response_headers, duration_ms, error_message, assertions_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRunsByTestDefId: db.prepare(
    "SELECT * FROM test_runs WHERE test_def_id = ? ORDER BY run_at DESC LIMIT 20"
  ),

  // Orchestrator queries
  getAllInstancesWithLastAction: db.prepare(`
    SELECT
      i.*,
      ia.tool_name  AS last_tool,
      ia.created_at AS last_action_at,
      ia.result_ok  AS last_result_ok,
      p.id          AS plan_id,
      p.title       AS plan_title,
      p.status      AS plan_status,
      COUNT(DISTINCT pt.id)                                       AS task_count,
      SUM(CASE WHEN pt.status = 'done' THEN 1 ELSE 0 END)        AS tasks_done
    FROM instances i
    LEFT JOIN instance_actions ia ON ia.id = (
      SELECT id FROM instance_actions WHERE instance_id = i.instance_id ORDER BY id DESC LIMIT 1
    )
    LEFT JOIN plans p ON p.instance_id = i.instance_id AND p.status = 'active'
    LEFT JOIN plan_tasks pt ON pt.plan_id = p.id
    GROUP BY i.instance_id, ia.id, p.id
    ORDER BY i.last_heartbeat DESC
  `),

  getInstanceActions: db.prepare(
    "SELECT * FROM instance_actions WHERE instance_id = ? ORDER BY id DESC LIMIT 50"
  ),

  getMaxActionId: db.prepare(
    "SELECT COALESCE(MAX(id), 0) AS max_id FROM instance_actions"
  ),
};
