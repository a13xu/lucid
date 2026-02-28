# Lucid — MCP Memory Server

Persistent memory for Claude Code agents, backed by **SQLite + FTS5**.

Stores a knowledge graph (entities, relations, observations) with full-text search — indexed queries under 1ms, no JSON files, no linear scans.

## Why SQLite + FTS5 instead of JSON?

| | JSON file | SQLite + FTS5 |
|---|---|---|
| Search | O(n) linear scan | O(log n) indexed |
| Write | Rewrite entire file | Atomic incremental |
| Concurrent reads | Lock entire file | WAL mode |
| Stemming / unicode | Manual | Built-in |

## Tools (6)

| Tool | Description |
|---|---|
| `remember` | Store a fact about an entity (project, person, tool, decision…) |
| `relate` | Create a directed relationship between two entities |
| `recall` | Full-text search across all memory (FTS5 + LIKE fallback) |
| `recall_all` | Return the entire knowledge graph with stats |
| `forget` | Remove an entity and all its relations |
| `memory_stats` | DB size, WAL status, entity/relation counts |

### Entity types
`person` · `project` · `decision` · `pattern` · `tool` · `config` · `bug` · `convention`

### Relation types
`uses` · `depends_on` · `created_by` · `part_of` · `replaced_by` · `conflicts_with` · `tested_by`

## Install

**Requirements:** Node.js 18+

```bash
git clone https://github.com/<your-username>/lucid
cd lucid
npm install
npm run build
```

### Add to Claude Code

```bash
claude mcp add --transport stdio lucid -- node /ABSOLUTE/PATH/lucid/build/index.js
```

With custom DB path, add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "lucid": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/lucid/build/index.js"],
      "env": {
        "MEMORY_DB_PATH": "/your/project/.claude/memory.db"
      }
    }
  }
}
```

Default DB path: `~/.claude/memory.db`

## Usage examples

```
You:    "Remember that this project uses PostgreSQL with Prisma ORM"
Claude: [calls remember] → Created "PostgreSQL" [tool]

You:    "What do you know about the database?"
Claude: [calls recall("database PostgreSQL")] → returns entity + observations

You:    "How are the services connected?"
Claude: [calls recall_all] → returns full knowledge graph
```

## Database schema

```sql
CREATE TABLE entities (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    type         TEXT NOT NULL,
    observations TEXT NOT NULL DEFAULT '[]',   -- JSON array
    created_at   INTEGER DEFAULT (unixepoch()),
    updated_at   INTEGER DEFAULT (unixepoch())
);

CREATE TABLE relations (
    id            INTEGER PRIMARY KEY,
    from_entity   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_entity     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    UNIQUE(from_entity, to_entity, relation_type)
);

-- FTS5 index with Porter stemmer + Unicode
CREATE VIRTUAL TABLE entities_fts USING fts5(
    name, type, observations,
    content='entities', content_rowid='id',
    tokenize='porter unicode61'
);
```

## Debugging

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2024-11-05"}}' \
  | node build/index.js
```

In Claude Code: run `/mcp` — you should see `lucid` listed with 6 tools.

## Tech stack

- **Runtime:** Node.js 18+, TypeScript, ES modules
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Database:** `better-sqlite3` (synchronous, no async overhead)
- **Validation:** `zod`
- **Transport:** stdio
