# @a13xu/lucid

Memory, code indexing, and validation for Claude Code agents — backed by **SQLite + FTS5**.

Stores a persistent knowledge graph (entities, relations, observations), indexes source files as compressed binary with change detection, and validates code for LLM drift patterns.

## Install

**Requirements:** Node.js 18+

```bash
# Add to Claude Code (no install needed)
claude mcp add --transport stdio lucid -- npx -y @a13xu/lucid
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "lucid": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@a13xu/lucid"],
      "env": {
        "MEMORY_DB_PATH": "/your/project/.claude/memory.db"
      }
    }
  }
}
```

Default DB path: `~/.claude/memory.db`

## Quick start

```
1. "Index this project" → init_project() → scans CLAUDE.md, package.json, src/
2. Write code          → sync_file(path) → compressed + hashed in DB
3. "Where is X used?"  → grep_code("X") → matching lines only, no full file
4. "What do we know?"  → recall("query") → knowledge graph search
```

## Tools (13)

### Memory
| Tool | Description |
|---|---|
| `remember` | Store a fact about an entity (project, person, tool, decision…) |
| `relate` | Create a directed relationship between two entities |
| `recall` | Full-text search across all memory (FTS5 + LIKE fallback) |
| `recall_all` | Return the entire knowledge graph with statistics |
| `forget` | Remove an entity and all its relations |
| `memory_stats` | DB size, WAL status, entity/relation counts |

### Code indexing
| Tool | Description |
|---|---|
| `init_project` | Scan project directory and bootstrap knowledge graph. Reads `CLAUDE.md`, `package.json`/`pyproject.toml`, `README.md`, `.mcp.json`, `logic-guardian.yaml`, source files. Also installs a Claude Code hook for auto-sync. |
| `sync_file` | Index or re-index a single file after writing/editing. Stores compressed binary (zlib-9), skips instantly if SHA-256 hash unchanged. |
| `sync_project` | Re-index entire project incrementally. Reports compression ratio. |
| `grep_code` | Regex search across all indexed files. Decompresses binary on-the-fly, returns only matching lines with context — ~20-50 tokens vs reading full files. |

### Logic Guardian
| Tool | Description |
|---|---|
| `validate_file` | Detect LLM drift patterns in a source file: logic inversions, null propagation, type confusion, copy-paste drift, silent exceptions. Supports Python, JS, TS. |
| `check_drift` | Analyze a code snippet inline without saving to disk. |
| `get_checklist` | Return the full 5-pass validation protocol (Logic Trace, Contract Verification, Stupid Mistakes, Integration Sanity, Explain It). |

## Why no vectors?

Code has explicit structure — no NLP needed:

| Need | Approach | Tokens |
|---|---|---|
| "Where is X defined?" | `grep_code("export.*X")` | ~30 |
| "What does auth.ts export?" | `recall("auth.ts")` | ~50 |
| "Project conventions?" | `recall("CLAUDE.md conventions")` | ~80 |
| Read full file | `Read tool` | ~500-2000 |

Source files are stored as **zlib-deflate level 9 BLOBs** (~70% smaller than plain text). Change detection via SHA-256 means `sync_file` is instant on unchanged files.

## Why SQLite + FTS5?

| | JSON file | SQLite + FTS5 |
|---|---|---|
| Search | O(n) linear scan | O(log n) indexed |
| Write | Rewrite entire file | Atomic incremental |
| Concurrent reads | Lock entire file | WAL mode |
| Code storage | Plain text | Compressed BLOB + hash |
| Change detection | Manual diff | SHA-256 per file |

## Entity types
`person` · `project` · `decision` · `pattern` · `tool` · `config` · `bug` · `convention`

## Relation types
`uses` · `depends_on` · `created_by` · `part_of` · `replaced_by` · `conflicts_with` · `tested_by`

## Debugging

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2024-11-05"}}' \
  | npx @a13xu/lucid
```

In Claude Code: run `/mcp` — you should see `lucid` with 13 tools.

## Tech stack

- **Runtime:** Node.js 18+, TypeScript, ES modules
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Database:** `better-sqlite3` (synchronous, WAL mode)
- **Compression:** Node.js built-in `zlib` (deflate level 9)
- **Hashing:** SHA-256 via `crypto` (change detection)
- **Validation:** `zod`
- **Transport:** stdio
