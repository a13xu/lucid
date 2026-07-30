# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lucid** is an MCP (Model Context Protocol) server (`@a13xu/lucid`) that gives Claude Code persistent memory, intelligent code indexing, context retrieval, and LLM drift detection via 20 MCP tools.

## Commands

```bash
# Build TypeScript → build/
npm run build

# Start Web UI (Express on port 3001)
npm run web:install   # first time only
npm run web

# Register with Claude Code (after build)
claude mcp add --transport stdio lucid -- node /absolute/path/lucid/build/index.js

# Run as global binary
npm install -g @a13xu/lucid && lucid

# Run via npx
npx -y @a13xu/lucid
```

No automated test suite. TypeScript strict mode (`strict: true`) is the linter. Validate with Logic Guardian (`validate_file`, `check_drift`) after changes.

## Architecture

**Entry point:** `src/index.ts` — initializes SQLite, registers 20 tools, sets up `StdioServerTransport`, optionally auto-starts Web UI.

**Request pipeline (every tool call):**
```
Claude Code → StdioServerTransport → guardRequest() [rate limit + WAF + SSRF] → handler → guardOutput() [secret scan] → response
```

**Database:** Single SQLite file (default `~/.claude/memory.db`, override with `MEMORY_DB_PATH`). WAL mode. 9 tables:
- `entities`, `relations`, `entities_fts` — Knowledge graph (FTS5 with Porter stemming)
- `file_contents`, `file_diffs` — Indexed files (zlib level-9 compression + SHA256 change detection)
- `experiences`, `file_rewards` — Reward signals for TF-IDF ranking
- `plans`, `plan_tasks` — Development plan tracking
- `instances`, `instance_actions` — Audit log (heartbeat every 15s, max 200 actions kept)

**Key source modules:**

| Module | Purpose |
|--------|---------|
| `src/database.ts` | Schema + all prepared statements |
| `src/tools/init.ts` | `init_project` — scans CLAUDE.md, package.json, source files, installs PostToolUse hook |
| `src/indexer/` | `file.ts` extracts exports/TODOs; `ast.ts` builds skeletons (signatures only, no bodies); `project.ts` recursive scan |
| `src/retrieval/context.ts` | `get_context` — TF-IDF ranking + recency boost + skeleton pruning to stay within token budget |
| `src/retrieval/tfidf.ts` | TF-IDF computed on-the-fly across all indexed files |
| `src/guardian/validator.ts` | Regex-based drift detection (Python/JS/TS patterns) |
| `src/guardian/coding-analyzer.ts` | 25 Golden Rules checker (file size, naming, nesting, component rules) |
| `src/security/guard.ts` | Rate limiting + WAF injection detection + SSRF allowlist + output secret scan |
| `src/store/content.ts` | zlib compress/decompress + SHA256 hash |
| `src/tools/plan.ts` | Plan CRUD + task status transitions |
| `src/memory/experience.ts` | Reward/penalize signals, decay (half-life ~14 days) |

**Web UI** (`web/`): Separate Express app (port 3001). Uses its own better-sqlite3 instance. Routes: `/api/plans`, `/api/tasks`, `/api/tests`, `/api/orchestrator`, `/api/auto-tools`, `/api/worker`. Frontend SPA in `web/public/app.js`.

## Key Patterns

**Adding a new MCP tool:**
1. Create handler in `src/tools/<name>.ts`
2. Register in `src/index.ts`: add to `ListToolsRequestSchema` response + `CallToolRequestSchema` switch
3. If it needs new DB tables, add schema + prepared statements in `src/database.ts`

**Context retrieval strategy:**
- Files under `maxTokensPerFile` (default 400 tokens) → return full source
- Files over limit → return skeleton (imports + function signatures only)
- Relevant fragments extracted if skeleton still exceeds budget
- `reward()`/`penalize()` update `file_rewards` cache to boost/suppress files in future queries

**Sync hook auto-installation:** `init_project` writes a `PostToolUse` hook to `.claude/settings.json` that reminds Claude to call `sync_file(path)` after every file edit. This keeps the knowledge graph current.

**Module system:** ES modules throughout (`"type": "module"` in package.json, `"module": "Node16"` in tsconfig). Use `.js` extensions in imports even for `.ts` source files.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMORY_DB_PATH` | `~/.claude/memory.db` | SQLite database location |
| `QDRANT_URL` | — | Optional vector DB; falls back to TF-IDF if not set |
| `QDRANT_API_KEY` | — | Qdrant auth |
| `OPENAI_API_KEY` | — | For embeddings (if using Qdrant) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `LUCID_INSTANCE_LABEL` | — | Optional identifier for multi-instance setups |

## Optional Config (`lucid.config.json`)

Place in project root to customize indexing, token budgets, security, and Qdrant:
```json
{
  "whitelistDirs": ["src"],
  "blacklistDirs": ["migrations"],
  "maxTokensPerFile": 400,
  "maxContextTokens": 4000,
  "recentWindowHours": 24,
  "security": { "rateLimiting": true, "waf": true, "outputScan": true }
}
```
