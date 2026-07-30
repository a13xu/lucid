# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lucid** is an MCP (Model Context Protocol) server (`@a13xu/lucid`) that gives Claude Code persistent memory, intelligent code indexing, context retrieval, and LLM drift detection via ~45 MCP tools grouped into dynamic toolsets.

## Commands

```bash
# Build TypeScript → build/
npm run build

# Run tests (vitest)
npm test

# Register with Claude Code (after build)
claude mcp add --transport stdio lucid -- node /absolute/path/lucid/build/index.js

# Run as global binary
npm install -g @a13xu/lucid && lucid

# Run via npx
npx -y @a13xu/lucid
```

TypeScript strict mode (`strict: true`) is the linter. Validate with Logic Guardian (`validate_file`, `check_drift`) after changes.

## Architecture

**Entry point:** `src/index.ts` (~120 LOC) — CLI dispatch via `src/cli.ts` (`lucid watch|status|stop|guard|session|local|book`), then SQLite init, security guard, domain registration, `StdioServerTransport`.

**Tool registration:** `src/registry/<domain>.ts` modules (memory, indexing, retrieval, reward, guardian, plan, ops, local, book, webdev), each exporting `register*(server, ctx)` → map of `RegisteredTool` handles. `registry/shared.ts` holds the `tx()` guard wrapper + `RegistryCtx`. Non-core domains (webdev, book, local) start **disabled** (dynamic toolsets, `registry/toolsets.ts`) — the `lucid_toolsets` tool enables them per-session; override via `toolsets.disabled` in config or `LUCID_TOOLSETS_DISABLED` env ("none" = all visible).

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

**HTTP daemon** (`src/http/`): `lucid watch` starts a chokidar watcher + Express server on port 7821 (`/sync`, `/sync-project`, `/context`, `/validate`, `/health`) so hooks and shell scripts can sync without going through Claude. (`web/` contains remnants of a removed Express UI — not shipped, not runnable.)

## Key Patterns

**Adding a new MCP tool:**
1. Create handler in `src/tools/<name>.ts`
2. Register it in the matching `src/registry/<domain>.ts` module (wrap the handler with `tx()`); new domains also need an entry in the `domains` map in `src/index.ts`
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
