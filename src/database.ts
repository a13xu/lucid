import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import type { EntityRow, RelationRow } from "./types.js";

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  const envPath = process.env["MEMORY_DB_PATH"];
  if (envPath) return envPath;
  return join(homedir(), ".claude", "memory.db");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDatabase(): Database.Database {
  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Pragmas obligatorii
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -8000");
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 67108864");
  db.pragma("foreign_keys = ON");

  createSchema(db);
  console.error(`[lucid] DB: ${dbPath}`);
  return db;
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      type         TEXT NOT NULL,
      observations TEXT NOT NULL DEFAULT '[]',
      created_at   INTEGER DEFAULT (unixepoch()),
      updated_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS relations (
      id            INTEGER PRIMARY KEY,
      from_entity   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_entity     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      created_at    INTEGER DEFAULT (unixepoch()),
      UNIQUE(from_entity, to_entity, relation_type)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
      name,
      type,
      observations,
      content='entities',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
      INSERT INTO entities_fts(rowid, name, type, observations)
      VALUES (new.id, new.name, new.type, new.observations);
    END;

    CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, type, observations)
      VALUES('delete', old.id, old.name, old.type, old.observations);
      INSERT INTO entities_fts(rowid, name, type, observations)
      VALUES (new.id, new.name, new.type, new.observations);
    END;

    CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, type, observations)
      VALUES('delete', old.id, old.name, old.type, old.observations);
    END;

    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
    CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_entity);
    CREATE INDEX IF NOT EXISTS idx_entities_type  ON entities(type);

    -- Conținut sursă comprimat (zlib deflate nivel 9)
    CREATE TABLE IF NOT EXISTS file_contents (
      id              INTEGER PRIMARY KEY,
      filepath        TEXT NOT NULL UNIQUE,
      content         BLOB NOT NULL,
      content_hash    TEXT NOT NULL,
      original_size   INTEGER NOT NULL,
      compressed_size INTEGER NOT NULL,
      language        TEXT NOT NULL DEFAULT 'generic',
      indexed_at      INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_fc_filepath ON file_contents(filepath);
    CREATE INDEX IF NOT EXISTS idx_fc_hash     ON file_contents(content_hash);
    CREATE INDEX IF NOT EXISTS idx_fc_indexed  ON file_contents(indexed_at);

    -- Diffs între versiuni consecutive (pentru get_recent)
    CREATE TABLE IF NOT EXISTS file_diffs (
      filepath    TEXT PRIMARY KEY,
      prev_hash   TEXT NOT NULL,
      diff_text   TEXT NOT NULL,
      changed_at  INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_fd_changed ON file_diffs(changed_at);

    -- Experiences: logged get_context calls for RL reward system
    CREATE TABLE IF NOT EXISTS experiences (
      id          INTEGER PRIMARY KEY,
      query       TEXT NOT NULL,
      query_terms TEXT NOT NULL DEFAULT '',
      context_fps TEXT NOT NULL DEFAULT '[]',
      strategy    TEXT NOT NULL DEFAULT 'tfidf',
      reward      REAL NOT NULL DEFAULT 0.0,
      feedback    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      rewarded_at INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
      query,
      feedback,
      content='experiences',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS experiences_ai AFTER INSERT ON experiences BEGIN
      INSERT INTO experiences_fts(rowid, query, feedback)
      VALUES (new.id, new.query, COALESCE(new.feedback, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS experiences_au AFTER UPDATE ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, query, feedback)
      VALUES('delete', old.id, old.query, COALESCE(old.feedback, ''));
      INSERT INTO experiences_fts(rowid, query, feedback)
      VALUES (new.id, new.query, COALESCE(new.feedback, ''));
    END;

    -- Denormalized reward cache per file (updated on every reward/penalize/implicit)
    CREATE TABLE IF NOT EXISTS file_rewards (
      filepath      TEXT PRIMARY KEY,
      total_reward  REAL NOT NULL DEFAULT 0.0,
      use_count     INTEGER NOT NULL DEFAULT 0,
      last_rewarded INTEGER
    );

    -- Planning tables
    CREATE TABLE IF NOT EXISTS plans (
      id          INTEGER PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      user_story  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  INTEGER DEFAULT (unixepoch()),
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS plan_tasks (
      id            INTEGER PRIMARY KEY,
      plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      test_criteria TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      notes         TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id, seq);
    CREATE INDEX IF NOT EXISTS idx_plans_status    ON plans(status);

    -- Instance tracking tables
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
      instance_id  TEXT NOT NULL REFERENCES instances(instance_id) ON DELETE CASCADE,
      tool_name    TEXT NOT NULL,
      args_json    TEXT NOT NULL DEFAULT '{}',
      result_ok    INTEGER NOT NULL DEFAULT 1,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ia_instance ON instance_actions(instance_id, created_at DESC);
  `);

  // Migration: add instance_id column to plans if it doesn't exist yet
  try {
    db.exec("ALTER TABLE plans ADD COLUMN instance_id TEXT");
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes("duplicate column name")) throw e;
  }
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// Alias pentru lizibilitate — Statement<Params, Row> pentru .get()/.all()
type Stmt<P extends unknown[], R> = Database.Statement<P, R>;
// Pentru write-only (.run() only) — Row = unknown (nu contează)
type WriteStmt<P extends unknown[]> = Database.Statement<P, unknown>;

export interface FileContentRow {
  id: number;
  filepath: string;
  content: Buffer;
  content_hash: string;
  original_size: number;
  compressed_size: number;
  language: string;
  indexed_at: number;
}

export interface FileDiffRow {
  filepath: string;
  prev_hash: string;
  diff_text: string;
  changed_at: number;
}

export interface ExperienceRow {
  id: number;
  query: string;
  query_terms: string;
  context_fps: string;  // JSON array of filepath strings
  strategy: string;
  reward: number;
  feedback: string | null;
  created_at: number;
  rewarded_at: number | null;
}

export interface FileRewardRow {
  filepath: string;
  total_reward: number;
  use_count: number;
  last_rewarded: number | null;
}

export interface InstanceRow {
  instance_id: string;
  pid: number;
  label: string;
  started_at: number;
  last_heartbeat: number;
  status: string;
}

export interface InstanceActionRow {
  id: number;
  instance_id: string;
  tool_name: string;
  args_json: string;
  result_ok: number;
  duration_ms: number;
  created_at: number;
}

export interface PlanRow {
  id: number;
  title: string;
  description: string;
  user_story: string;
  status: string;
  instance_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlanTaskRow {
  id: number;
  plan_id: number;
  seq: number;
  title: string;
  description: string;
  test_criteria: string;
  status: string;
  notes: string;  // JSON string
  created_at: number;
  updated_at: number;
}

export interface Statements {
  // file_contents
  getFileByPath:    Stmt<[string], FileContentRow>;
  upsertFile:       WriteStmt<[string, Buffer, string, number, number, string]>;
  getAllFiles:       Stmt<[], Pick<FileContentRow, "filepath" | "content" | "language" | "content_hash" | "indexed_at">>;
  getRecentFiles:   Stmt<[number], Pick<FileContentRow, "filepath" | "language" | "indexed_at">>;
  deleteFile:       WriteStmt<[string]>;
  fileStorageStats: Stmt<[], { count: number; total_original: number; total_compressed: number }>;
  // file_diffs
  upsertDiff:    WriteStmt<[string, string, string]>;
  getDiff:       Stmt<[string], FileDiffRow>;
  getRecentDiffs: Stmt<[number], FileDiffRow>;
  // entities
  getEntityByName:     Stmt<[string], EntityRow>;
  insertEntity:        WriteStmt<[string, string, string]>;
  // 2 params: observations(string), id(number)
  updateEntity:        WriteStmt<[string, number]>;
  deleteEntity:        WriteStmt<[string]>;
  getAllEntities:       Stmt<[], EntityRow>;
  getRelationsForEntity: Stmt<[number, number], RelationRow & { from_name: string; to_name: string }>;
  insertRelation:      WriteStmt<[number, number, string]>;
  searchFTS:           Stmt<[string], EntityRow>;
  searchLike:          Stmt<[string, string, string], EntityRow>;
  countEntities:       Stmt<[], { count: number }>;
  countRelations:      Stmt<[], { count: number }>;
  getWalMode:          Stmt<[], { journal_mode: string }>;
  getAllRelations:      Stmt<[], RelationRow & { from_name: string; to_name: string }>;
  // experiences (reward system)
  insertExperience:       WriteStmt<[string, string, string, string]>;   // query, query_terms, context_fps, strategy
  updateExperienceReward: WriteStmt<[number, string | null, number]>;    // delta, feedback|null, id
  getExperienceById:      Stmt<[number], ExperienceRow>;
  getTopExperiences:      Stmt<[number], ExperienceRow>;
  searchExperiencesFTS:   Stmt<[string, number], ExperienceRow>;
  // file_rewards
  upsertFileReward:       WriteStmt<[string, number]>;                   // filepath, delta_reward
  getFileRewards:         Stmt<[], FileRewardRow>;
  getTopFileRewards:      Stmt<[number], FileRewardRow>;
  // plans
  insertPlan:             WriteStmt<[string, string, string, string | null]>; // title, description, user_story, instance_id
  getPlanById:            Stmt<[number], PlanRow>;
  getAllPlans:             Stmt<[], PlanRow>;
  updatePlanStatus:       WriteStmt<[string, number]>;                   // status, id
  // plan_tasks
  insertPlanTask:         WriteStmt<[number, number, string, string, string]>; // plan_id, seq, title, description, test_criteria
  getTasksByPlanId:       Stmt<[number], PlanTaskRow>;
  getTaskById:            Stmt<[number], PlanTaskRow>;
  updateTaskStatus:       WriteStmt<[string, string, number]>;           // status, notes, id
  countRemainingTasks:    Stmt<[number], { count: number }>;             // plan_id → tasks != 'done'
}

export function prepareStatements(db: Database.Database): Statements {
  return {
    // file_contents
    getFileByPath: db.prepare<[string], FileContentRow>(
      "SELECT * FROM file_contents WHERE filepath = ?"
    ),

    upsertFile: db.prepare<[string, Buffer, string, number, number, string], unknown>(
      `INSERT INTO file_contents (filepath, content, content_hash, original_size, compressed_size, language)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(filepath) DO UPDATE SET
         content = excluded.content,
         content_hash = excluded.content_hash,
         original_size = excluded.original_size,
         compressed_size = excluded.compressed_size,
         language = excluded.language,
         indexed_at = unixepoch()`
    ),

    getAllFiles: db.prepare<[], Pick<FileContentRow, "filepath" | "content" | "language" | "content_hash" | "indexed_at">>(
      "SELECT filepath, content, language, content_hash, indexed_at FROM file_contents"
    ),

    getRecentFiles: db.prepare<[number], Pick<FileContentRow, "filepath" | "language" | "indexed_at">>(
      "SELECT filepath, language, indexed_at FROM file_contents WHERE indexed_at >= ? ORDER BY indexed_at DESC"
    ),

    deleteFile: db.prepare<[string], unknown>(
      "DELETE FROM file_contents WHERE filepath = ?"
    ),

    upsertDiff: db.prepare<[string, string, string], unknown>(
      `INSERT INTO file_diffs (filepath, prev_hash, diff_text)
       VALUES (?, ?, ?)
       ON CONFLICT(filepath) DO UPDATE SET
         prev_hash  = excluded.prev_hash,
         diff_text  = excluded.diff_text,
         changed_at = unixepoch()`
    ),

    getDiff: db.prepare<[string], FileDiffRow>(
      "SELECT * FROM file_diffs WHERE filepath = ?"
    ),

    getRecentDiffs: db.prepare<[number], FileDiffRow>(
      "SELECT * FROM file_diffs WHERE changed_at >= ? ORDER BY changed_at DESC"
    ),

    fileStorageStats: db.prepare<[], { count: number; total_original: number; total_compressed: number }>(
      "SELECT COUNT(*) as count, SUM(original_size) as total_original, SUM(compressed_size) as total_compressed FROM file_contents"
    ),

    // entities
    getEntityByName: db.prepare<[string], EntityRow>(
      "SELECT * FROM entities WHERE name = ? COLLATE NOCASE"
    ),

    insertEntity: db.prepare<[string, string, string], unknown>(
      "INSERT INTO entities (name, type, observations) VALUES (?, ?, ?)"
    ),

    // SQL: SET observations = ?, WHERE id = ?  →  2 params
    updateEntity: db.prepare<[string, number], unknown>(
      "UPDATE entities SET observations = ?, updated_at = unixepoch() WHERE id = ?"
    ),

    deleteEntity: db.prepare<[string], unknown>(
      "DELETE FROM entities WHERE name = ? COLLATE NOCASE"
    ),

    getAllEntities: db.prepare<[], EntityRow>(
      "SELECT * FROM entities ORDER BY updated_at DESC"
    ),

    getRelationsForEntity: db.prepare<[number, number], RelationRow & { from_name: string; to_name: string }>(
      `SELECT r.*, ef.name AS from_name, et.name AS to_name
       FROM relations r
       JOIN entities ef ON r.from_entity = ef.id
       JOIN entities et ON r.to_entity = et.id
       WHERE r.from_entity = ? OR r.to_entity = ?`
    ),

    insertRelation: db.prepare<[number, number, string], unknown>(
      "INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)"
    ),

    searchFTS: db.prepare<[string], EntityRow>(
      `SELECT e.* FROM entities_fts
       JOIN entities e ON entities_fts.rowid = e.id
       WHERE entities_fts MATCH ?
       ORDER BY rank
       LIMIT 20`
    ),

    searchLike: db.prepare<[string, string, string], EntityRow>(
      `SELECT * FROM entities
       WHERE name LIKE ? OR type LIKE ? OR observations LIKE ?
       ORDER BY updated_at DESC
       LIMIT 20`
    ),

    countEntities: db.prepare<[], { count: number }>(
      "SELECT COUNT(*) as count FROM entities"
    ),

    countRelations: db.prepare<[], { count: number }>(
      "SELECT COUNT(*) as count FROM relations"
    ),

    getWalMode: db.prepare<[], { journal_mode: string }>(
      "PRAGMA journal_mode"
    ),

    getAllRelations: db.prepare<[], RelationRow & { from_name: string; to_name: string }>(
      `SELECT r.*, ef.name AS from_name, et.name AS to_name
       FROM relations r
       JOIN entities ef ON r.from_entity = ef.id
       JOIN entities et ON r.to_entity = et.id`
    ),

    // experiences
    insertExperience: db.prepare<[string, string, string, string], unknown>(
      `INSERT INTO experiences (query, query_terms, context_fps, strategy)
       VALUES (?, ?, ?, ?)`
    ),

    updateExperienceReward: db.prepare<[number, string | null, number], unknown>(
      `UPDATE experiences SET
         reward = reward + ?,
         rewarded_at = unixepoch(),
         feedback = COALESCE(?, feedback)
       WHERE id = ?`
    ),

    getExperienceById: db.prepare<[number], ExperienceRow>(
      "SELECT * FROM experiences WHERE id = ?"
    ),

    getTopExperiences: db.prepare<[number], ExperienceRow>(
      "SELECT * FROM experiences ORDER BY reward DESC LIMIT ?"
    ),

    searchExperiencesFTS: db.prepare<[string, number], ExperienceRow>(
      `SELECT e.* FROM experiences_fts
       JOIN experiences e ON experiences_fts.rowid = e.id
       WHERE experiences_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    ),

    // file_rewards
    upsertFileReward: db.prepare<[string, number], unknown>(
      `INSERT INTO file_rewards (filepath, total_reward, use_count, last_rewarded)
       VALUES (?, ?, 1, unixepoch())
       ON CONFLICT(filepath) DO UPDATE SET
         total_reward  = total_reward + excluded.total_reward,
         use_count     = use_count + 1,
         last_rewarded = unixepoch()`
    ),

    getFileRewards: db.prepare<[], FileRewardRow>(
      "SELECT * FROM file_rewards"
    ),

    getTopFileRewards: db.prepare<[number], FileRewardRow>(
      "SELECT * FROM file_rewards WHERE total_reward > 0 ORDER BY total_reward DESC LIMIT ?"
    ),

    // plans
    insertPlan: db.prepare<[string, string, string, string | null], unknown>(
      "INSERT INTO plans (title, description, user_story, instance_id) VALUES (?, ?, ?, ?)"
    ),

    getPlanById: db.prepare<[number], PlanRow>(
      "SELECT * FROM plans WHERE id = ?"
    ),

    getAllPlans: db.prepare<[], PlanRow>(
      "SELECT * FROM plans ORDER BY created_at DESC"
    ),

    updatePlanStatus: db.prepare<[string, number], unknown>(
      "UPDATE plans SET status = ?, updated_at = unixepoch() WHERE id = ?"
    ),

    // plan_tasks
    insertPlanTask: db.prepare<[number, number, string, string, string], unknown>(
      "INSERT INTO plan_tasks (plan_id, seq, title, description, test_criteria) VALUES (?, ?, ?, ?, ?)"
    ),

    getTasksByPlanId: db.prepare<[number], PlanTaskRow>(
      "SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY seq"
    ),

    getTaskById: db.prepare<[number], PlanTaskRow>(
      "SELECT * FROM plan_tasks WHERE id = ?"
    ),

    updateTaskStatus: db.prepare<[string, string, number], unknown>(
      "UPDATE plan_tasks SET status = ?, notes = ?, updated_at = unixepoch() WHERE id = ?"
    ),

    countRemainingTasks: db.prepare<[number], { count: number }>(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status != 'done'"
    ),
  };
}
