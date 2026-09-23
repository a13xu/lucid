# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lucid** is an MCP (Model Context Protocol) server (`@a13xu/lucid`) that gives Claude Code persistent memory, intelligent code indexing, context retrieval, and LLM drift detection via 50 MCP tools grouped into dynamic toolsets (35 visible by default).

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

# One-time: download tree-sitter grammar WASMs (~3.4MB) into ~/.lucid/grammars/
# → exact AST skeletons for TS/JS/Python; without them a regex fallback is used
lucid setup grammars

# One-time: install the Claude Code status line + /tasks command into ~/.claude/
# → renders templates from scripts/statusline/ and registers statusLine
lucid setup statusline
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
- `plans`, `plan_tasks` — Development plan tracking, scoped per project via
  `plans.project` (canonical project root; `''` on rows predating the column)
- `instances`, `instance_actions` — Audit log (heartbeat every 15s, max 200 actions kept)

**Key source modules:**

| Module | Purpose |
|--------|---------|
| `src/database.ts` | Schema + all prepared statements |
| `src/tools/init.ts` | `init_project` — scans CLAUDE.md, package.json, source files, installs PreToolUse (backup + truncate guard) and PostToolUse (sync) hooks, matcher `Write\|Edit\|NotebookEdit` (MultiEdit no longer exists — folded into Edit) |
| `src/indexer/` | `file.ts` extracts exports/TODOs; `ast.ts` builds skeletons (signatures only, no bodies) — tree-sitter (`tree-sitter.ts` + `grammars.ts`, optional WASM) with regex fallback; `project.ts` recursive scan with mtime+size incremental shortcut |
| `src/retrieval/context.ts` | `get_context` — TF-IDF ranking + recency boost + skeleton pruning to stay within token budget |
| `src/retrieval/tfidf.ts` | TF-IDF computed on-the-fly across all indexed files |
| `src/guardian/validator.ts` | Regex-based drift detection (Python/JS/TS patterns) |
| `src/guardian/coding-analyzer.ts` | 25 Golden Rules checker (file size, naming, nesting, component rules) |
| `src/security/guard.ts` | Rate limiting + WAF injection detection + SSRF allowlist + output secret scan |
| `src/store/content.ts` | zlib compress/decompress + SHA256 hash |
| `src/project.ts` | Project root + canonical scope key shared by every project-aware tool |
| `src/setup/statusline.ts` | `lucid setup statusline` — renders `scripts/statusline/*` into `~/.claude/`, merges `statusLine` into settings.json (backs up first) |
| `scripts/statusline/lucid-statusline.mjs` | Status bar template. Quota from stdin `rate_limits` (CC ≥ 2.1.251), OAuth endpoint only for model-scoped weekly caps + fallback; cache split `{core, scoped}`; `🪟 ctx` from `context_window.used_percentage`. Percent normalisation happens exactly once, at the call site that knows the source format |
| `src/tools/plan.ts` | Plan CRUD, task status transitions, archive/delete/cleanup — all scoped to the current project |
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

**`.mcp.json` is gitignored:** keep the real absolute-path config local. A committed placeholder copy shadows the parent registration for sessions started inside `lucid/` and kills the server at boot (`CONNECTION_CLOSED`).

**Sync hook auto-installation:** `init_project` writes a `PostToolUse` hook to `.claude/settings.json` that runs `lucid-sync` (`src/lucid-sync.ts`) after every Write/Edit/NotebookEdit. It reads the hook JSON from stdin and syncs the file itself — daemon first, direct SQLite otherwise — so nobody has to call `sync_file` by hand. Edits made outside those tools (Bash, `git pull`) still need `sync_project()`.

**Prompt text Lucid ships** — `skills/*/SKILL.md`, the `LUCID_SYNC` block `init_project` appends to a project's CLAUDE.md, and tool descriptions — is read by current Claude models, which follow instructions literally. Write it in plain language with the reason next to each rule, and enforce anything that must always happen in a hook rather than in prose.

**Module system:** ES modules throughout (`"type": "module"` in package.json, `"module": "Node16"` in tsconfig). Use `.js` extensions in imports even for `.ts` source files.

## Status bar

`scripts/statusline/lucid-statusline.mjs` and `lucid-tasks.mjs` are templates with a `__LUCID_ROOT__` placeholder; `lucid setup statusline` renders them into `~/.claude/`, installs `commands/tasks.md`, and registers `statusLine` in `~/.claude/settings.json`. The installed files are generated — edit the templates. Segments degrade independently (a missing DB, module, token, or network drops only that segment):

- **Quota (5h / 7d):** stdin `rate_limits` on Claude Code ≥ 2.1.251 — no network. The OAuth usage endpoint (`GET https://api.anthropic.com/api/oauth/usage`, token from `~/.claude/.credentials.json`, sent nowhere else) runs only for model-scoped weekly caps (`limits[]` kind `weekly_scoped`) and as the fallback on older versions. Cached 60 s in `~/.claude/lucid-quota-cache.json` as `{core, scoped}`, served stale up to 30 min on failure (429 is routine); `--debug-usage` bypasses the cache and dumps raw JSON to stderr.
- **`🪟 ctx`:** stdin `context_window.used_percentage`, `⚠` from 85 % (auto-compact threshold).
- **`📋` plan:** most recent active plan of the session's project, scoped by importing `resolveScope`/`isSameProject` from `build/project.js`; `/tasks` (`/tasks --all`) prints the full list.
- **`👁 watch`:** only while the `lucid watch` daemon is alive (`~/.lucid/watch.pid` + signal 0).

## Gotchas

- **Releases:** npm has 2FA — `npm publish --otp=<code>`. Bump the version before committing on top of an already-published one.
- **After a Node major upgrade**, run `npm rebuild better-sqlite3`; otherwise the MCP server and the status bar die with `NODE_MODULE_VERSION` mismatch.
- **Schema drift:** the real `~/.claude/memory.db` has columns and tables no code here creates (`plans.instance_id`, `plan_tasks.is_e2e`, `playwright_*`, …). Migrations must be strictly additive, and new indexes on new columns go in `migrateSchema`, not `createSchema`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMORY_DB_PATH` | `~/.claude/memory.db` | SQLite database location |
| `LUCID_PROJECT_ROOT` | auto-detected from cwd | Override the project a session's plans belong to |
| `LUCID_PROJECT_NAME` | dir name / `package.json` name | Override the project's display label |
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
