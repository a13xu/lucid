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
  `);
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// Alias pentru lizibilitate — Statement<Params, Row> pentru .get()/.all()
type Stmt<P extends unknown[], R> = Database.Statement<P, R>;
// Pentru write-only (.run() only) — Row = unknown (nu contează)
type WriteStmt<P extends unknown[]> = Database.Statement<P, unknown>;

export interface Statements {
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
}

export function prepareStatements(db: Database.Database): Statements {
  return {
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
  };
}
