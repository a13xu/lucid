# @a13xu/lucid

[![npm version](https://img.shields.io/npm/v/@a13xu/lucid)](https://www.npmjs.com/package/@a13xu/lucid)
[![npm downloads](https://img.shields.io/npm/dm/@a13xu/lucid)](https://www.npmjs.com/package/@a13xu/lucid)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **MCP server for Claude Code** — persistent memory, smart code indexing, and code quality validation. Works out of the box with zero configuration.

Token-efficient memory, code indexing, and validation for Claude Code agents — backed by **SQLite + FTS5**.

Stores a persistent knowledge graph (entities, relations, observations), indexes source files as compressed binary with change detection, retrieves minimal relevant context via TF-IDF or Qdrant, and validates code for LLM drift patterns. Supports TypeScript, JavaScript, Python, **Vue, Nuxt**.

## Install

**Requirements:** Node.js 18+

```bash
# Option 1 — global install (recommended, faster startup)
npm install -g @a13xu/lucid
claude mcp add --transport stdio lucid -- lucid

# Option 2 — no install needed (uses npx on each start)
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
1. "Index this project" → init_project()        → scans CLAUDE.md, package.json, src/**
2. Write code          → sync_file(path)         → compressed + hashed + diff stored
3. "What's relevant?"  → get_context("auth flow") → TF-IDF ranked skeletons, ~500 tokens
4. "What changed?"     → get_recent(hours=2)      → line diffs of recent edits
5. "Where is X used?"  → grep_code("X")           → matching lines only, ~30 tokens
6. "What do we know?"  → recall("query")          → knowledge graph search
```

## Tools (20)

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
| `init_project` | Scan project directory recursively and bootstrap knowledge graph. Reads `CLAUDE.md`, `package.json`/`pyproject.toml`, `README.md`, `.mcp.json`, `logic-guardian.yaml`, all source files. Installs a Claude Code hook for auto-sync. |
| `sync_file` | Index or re-index a single file after writing/editing. Stores compressed binary (zlib-9), skips instantly if SHA-256 hash unchanged. Stores line-level diff from previous version. |
| `sync_project` | Re-index entire project incrementally. Reports compression ratio. |
| `grep_code` | Regex search across all indexed files. Decompresses binary on-the-fly, returns only matching lines with context — ~20-50 tokens vs reading full files. |

### Token optimization
| Tool | Description |
|---|---|
| `get_context` | **Smart context retrieval.** Ranks all indexed files by TF-IDF relevance (or Qdrant vector search if `QDRANT_URL` is set), applies recency boost, returns skeletons (imports + signatures only) for large files. Respects `maxContextTokens` budget. |
| `get_recent` | Return files modified in the last N hours with line-level diffs. |

### Logic Guardian
| Tool | Description |
|---|---|
| `validate_file` | Detect LLM drift patterns in a source file: logic inversions, null propagation, type confusion, copy-paste drift, silent exceptions. Supports Python, JS, TS. |
| `check_drift` | Analyze a code snippet inline without saving to disk. |
| `get_checklist` | Return the full 5-pass validation protocol (Logic Trace, Contract Verification, Stupid Mistakes, Integration Sanity, Explain It). |

### Reward system
| Tool | Description |
|---|---|
| `reward` | Signal that the last `get_context()` result was helpful (+1). Rewarded files rank higher in future similar queries. |
| `penalize` | Signal that the last `get_context()` result was unhelpful (-1). Penalized files rank lower in future queries. |
| `show_rewards` | Show top rewarded experiences and most rewarded files. Rewards decay exponentially (half-life ~14 days). |

### Code Quality Guard
| Tool | Description |
|---|---|
| `coding_rules` | Get the 25 Golden Rules checklist — naming, single responsibility, file/function size, error handling, frontend component rules, architecture separation. |
| `check_code_quality` | Analyze a file or snippet against the 25 Golden Rules. Detects file/function bloat, vague naming, deep nesting, dead code, and for React/Vue files: prop explosion, inline styles, fetch-in-component, direct DOM access. Complements `validate_file`. |

## Token optimization in depth

### How `get_context` works

```
query: "auth middleware"
         ↓
  1. TF-IDF score all indexed files against query
     (or Qdrant top-k if QDRANT_URL is set)
         ↓
  2. Boost recently-modified files (+0.3 score)
         ↓
  3. Apply whitelist dirs filter (if configured)
         ↓
  4. For each file within token budget:
       file < maxTokensPerFile  → return full source
       file > maxTokensPerFile  → return skeleton only
                                   (imports + signatures + TODOs)
                                   + relevant fragments around query terms
         ↓
  output: ~500–2000 tokens  vs  5000–20000 for reading full files
```

### Skeleton pruning (AST-based)

Large files are replaced with their structural skeleton:

```typescript
// src/middleware/auth.ts [skeleton]
// Validates JWT tokens and attaches user to request context

import { Request, Response, NextFunction } from "express"
import { verifyToken } from "../services/jwt.js"

// — exports —
export function authMiddleware(req: Request, res: Response, next: NextFunction): void { … }
export function requireRole(role: string): RequestHandler { … }
export type AuthenticatedRequest = Request & { user: User }
```

vs reading the full 200-line file.

### Qdrant vector search (optional)

Set env vars to enable semantic search instead of TF-IDF:

```bash
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-key          # optional
OPENAI_API_KEY=sk-...            # for embeddings
EMBEDDING_MODEL=text-embedding-3-small  # optional
```

Or in `.mcp.json`:
```json
{
  "mcpServers": {
    "lucid": {
      "command": "npx", "args": ["-y", "@a13xu/lucid"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Falls back to TF-IDF automatically if Qdrant is unreachable.

### Configuration (`lucid.config.json`)

Create in your project root to customize behavior:

```json
{
  "whitelistDirs": ["src", "backend", "api"],
  "blacklistDirs": ["migrations", "fixtures"],
  "maxTokensPerFile": 400,
  "maxContextTokens": 6000,
  "recentWindowHours": 12
}
```

| Key | Default | Description |
|---|---|---|
| `whitelistDirs` | — | Only index/return files from these dirs |
| `blacklistDirs` | — | Extra dirs to skip (merged with built-in skips) |
| `maxTokensPerFile` | `400` | Files above this get skeleton treatment |
| `maxContextTokens` | `4000` | Total token budget for `get_context` |
| `recentWindowHours` | `24` | "Recently touched" threshold |

## Why no vectors by default?

Code has explicit structure — no NLP needed for most queries:

| Need | Approach | Tokens |
|---|---|---|
| "Where is X defined?" | `grep_code("export.*X")` | ~30 |
| "What does auth.ts export?" | `recall("auth.ts")` | ~50 |
| "What changed recently?" | `get_recent(hours=2)` | ~200 |
| "Context for this task" | `get_context("auth flow")` | ~500 |
| "Project conventions?" | `recall("CLAUDE.md conventions")` | ~80 |
| Read full file | `Read tool` | ~500–2000 |

TF-IDF is fast, deterministic, and requires zero external services. Qdrant is available when you need semantic similarity across large codebases.

## Why SQLite + FTS5?

| | JSON file | SQLite + FTS5 |
|---|---|---|
| Search | O(n) linear scan | O(log n) indexed |
| Write | Rewrite entire file | Atomic incremental |
| Concurrent reads | Lock entire file | WAL mode |
| Code storage | Plain text | Compressed BLOB + hash |
| Change detection | Manual diff | SHA-256 per file |
| Diff history | None | Line-level diffs per file |

## Entity types
`person` · `project` · `decision` · `pattern` · `tool` · `config` · `bug` · `convention`

## Relation types
`uses` · `depends_on` · `created_by` · `part_of` · `replaced_by` · `conflicts_with` · `tested_by`

## Debugging

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2024-11-05"}}' \
  | npx @a13xu/lucid
```

In Claude Code: run `/mcp` — you should see `lucid` with 20 tools.

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/a13xu/lucid).

1. Fork the repo
2. `npm install` → `npm run build`
3. Test locally: `claude mcp add --transport stdio lucid-dev -- node /path/to/lucid/build/index.js`
4. Open a PR

## Tech stack

- **Runtime:** Node.js 18+, TypeScript, ES modules
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Database:** `better-sqlite3` (synchronous, WAL mode)
- **Compression:** Node.js built-in `zlib` (deflate level 9)
- **Hashing:** SHA-256 via `crypto` (change detection)
- **Ranking:** TF-IDF (built-in) or Qdrant (optional, via REST)
- **Validation:** `zod`
- **Transport:** stdio
