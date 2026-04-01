# @a13xu/lucid

[![npm version](https://img.shields.io/npm/v/@a13xu/lucid)](https://www.npmjs.com/package/@a13xu/lucid)
[![npm downloads](https://img.shields.io/npm/dm/@a13xu/lucid)](https://www.npmjs.com/package/@a13xu/lucid)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **MCP server for Claude Code** — persistent memory, smart code indexing, model selection, and code quality validation. Works out of the box with zero configuration.

Token-efficient memory, code indexing, and validation for Claude Code agents — backed by **SQLite + FTS5**.

Stores a persistent knowledge graph (entities, relations, observations), indexes source files as compressed binary with change detection, retrieves minimal relevant context via TF-IDF or Qdrant, and validates code for LLM drift patterns. Supports TypeScript, JavaScript, Python, **Vue, Nuxt**. Optional **LLMLingua-2 semantic compression** reduces context tokens by 30–70% while preserving meaning.

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
1. "Index this project" → init_project()               → scans CLAUDE.md, package.json, src/**
2. Write code           → sync_file(path)               → compressed + hashed + diff stored
3. "What's relevant?"  → smart_context("auth flow")    → recall + code in one call, adaptive budget
4. "What model?"       → suggest_model("refactor auth") → haiku (lookup) or sonnet (reasoning)
5. "What changed?"     → get_recent(hours=2)            → line diffs of recent edits
6. "Where is X used?"  → grep_code("X")                → matching lines only, ~30 tokens
7. "What do we know?"  → recall("query")               → knowledge graph search
```

## Tools (37)

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
| `smart_context` | **Recommended entry point.** Combines `recall()` (knowledge graph) + `get_context()` (code files) in one call. Adaptive token budget: `simple`=2000, `moderate`=6000, `complex`=12000. Logs an experience for `reward()`/`penalize()` feedback. |
| `suggest_model` | Classify task complexity → recommend Claude model. Returns `{ model, model_id, reasoning, context_budget }`. Simple lookups → Haiku; reasoning/code → Sonnet. Call at the start of any workflow. |
| `get_context` | **Classic code context.** Ranks indexed files by TF-IDF (or Qdrant), applies recency boost, returns skeletons for large files. Respects `maxContextTokens` budget. |
| `get_recent` | Return files modified in the last N hours with line-level diffs. |
| `compress_text` | Compress any text using LLMLingua-2 semantic compression. Returns compressed text + stats (ratio, tokens saved). Model downloads ~700MB on first use. |

### Logic Guardian
| Tool | Description |
|---|---|
| `validate_file` | Detect LLM drift patterns in a source file: logic inversions, null propagation, type confusion, copy-paste drift, silent exceptions. Supports Python, JS, TS. |
| `check_drift` | Analyze a code snippet inline without saving to disk. |
| `get_checklist` | Return the full 5-pass validation protocol (Logic Trace, Contract Verification, Stupid Mistakes, Integration Sanity, Explain It). |

### Plans
| Tool | Description |
|---|---|
| `plan_create` | Create a development plan with title, description, and tasks. Returns plan ID. |
| `plan_list` | List all plans with status summary (total/done/in-progress tasks). |
| `plan_get` | Get full plan details including all tasks and their status. |
| `plan_update_task` | Update a task's status (`pending` → `in_progress` → `done` \| `blocked`) and optionally add notes. Accepts `task_id` as number or string. |

### Reward system
| Tool | Description |
|---|---|
| `reward` | Signal that the last `smart_context()`/`get_context()` result was helpful (+1). Rewarded files rank higher in future similar queries. |
| `penalize` | Signal that the last result was unhelpful (-1). Penalized files rank lower. Accepts optional `note` to log what was missing. |
| `show_rewards` | Show top rewarded experiences and most rewarded files. Rewards decay exponentially (half-life ~14 days). |

### Code Quality Guard
| Tool | Description |
|---|---|
| `coding_rules` | Get the 25 Golden Rules checklist — naming, single responsibility, file/function size, error handling, frontend component rules, architecture separation. |
| `check_code_quality` | Analyze a file or snippet against the 25 Golden Rules. Detects file/function bloat, vague naming, deep nesting, dead code, and for React/Vue files: prop explosion, inline styles, fetch-in-component, direct DOM access. Complements `validate_file`. |

### Web Dev Skills
| Tool | Description |
|---|---|
| `generate_component` | Generate a complete component scaffold from a natural language description. Supports React (TSX/JSX) and Vue/Nuxt (`<script setup>` Composition API). Styling: Tailwind, CSS Modules, or none. |
| `scaffold_page` | Generate a full page with layout, SEO head, and placeholder sections. Supports Nuxt (`useHead`), Next.js (`Metadata` API), and plain Vue. |
| `seo_meta` | Generate complete SEO metadata: HTML meta tags, Open Graph, Twitter Card, and JSON-LD structured data (Article, Product, WebSite, WebPage). |
| `accessibility_audit` | Audit HTML/JSX/Vue snippets for WCAG A/AA/AAA violations. Checks missing alt text, unlabeled inputs, empty buttons/links, positive tabindex, non-interactive click handlers, and more. Returns severity + corrected code. |
| `api_client` | Generate a typed TypeScript async fetch function for a REST endpoint. Includes error handling (throws on non-2xx), full type aliases, and a usage example. Auth: Bearer, cookie, API key, or none. |
| `test_generator` | Generate a complete test file covering happy path, edge cases, error path, and mock setup. Frameworks: Vitest, Jest, Playwright. Component testing: Vue Test Utils or React Testing Library. |
| `responsive_layout` | Generate a mobile-first responsive layout from a wireframe description. Output: Tailwind utility classes, CSS Grid with named areas, or Flexbox + media queries. Container types: full, centered, sidebar. |
| `security_scan` | Scan JS/TS/HTML/Vue for web security vulnerabilities: XSS, eval/injection, SQL injection, hardcoded secrets, open redirects, prototype pollution, path traversal, insecure CORS. Context-aware (frontend/backend/api). |
| `design_tokens` | Generate a complete design token set from a brand color and mood. Produces 11-step color scales (50–950), neutral scale, semantic aliases, typography, spacing, radius, and shadows. Output: CSS variables, Tailwind config, or JSON. |
| `perf_hints` | Analyze a component or page for Core Web Vitals issues (LCP, CLS, INP) and perf anti-patterns: missing image dimensions, render-blocking scripts, fetch-in-render, heavy click handlers, missing useMemo/computed, whole-library imports. |

## Token optimization in depth

### How `smart_context` works (recommended)

```
query: "auth middleware"
         ↓
  1. recall(query)  — knowledge graph search (entities, relations)
         ↓
  2. TF-IDF score all indexed files against query
     (or Qdrant top-k if QDRANT_URL is set)
         ↓
  3. Boost recently-modified files (+0.3 score)
     Boost rewarded files (+0.25 score, decayed)
         ↓
  4. For each file within token budget:
       file < maxTokensPerFile  → return full source
       file > maxTokensPerFile  → return skeleton only
                                   (imports + signatures + TODOs)
                                   + relevant fragments around query terms
         ↓
  5. Optional: LLMLingua-2 compression (if enabled in config)
         ↓
  output: merged knowledge + code — budget: 2k/6k/12k by task_type
```

### How `get_context` works (classic)

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

### Semantic compression (optional)

LLMLingua-2 (`microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`) identifies and drops semantically unimportant tokens before returning context to Claude — and before generating Qdrant embeddings.

Enable in `lucid.config.json`:

```json
{
  "semanticCompression": {
    "enabled": true,
    "ratio": 0.5,
    "minLength": 300,
    "applyToEmbeddings": true
  }
}
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Opt-in — model downloads ~700MB on first use |
| `ratio` | `0.5` | Fraction of tokens to keep (0.3 = keep 30%) |
| `minLength` | `300` | Skip compression for texts shorter than this |
| `applyToEmbeddings` | `true` | Also compress chunk text before Qdrant embedding |

Model is cached in `~/.lucid/models/` after first download. Falls back to uncompressed text on any error — safe to enable unconditionally.

### Configuration (`lucid.config.json`)

Create in your project root to customize behavior:

```json
{
  "whitelistDirs": ["src", "backend", "api"],
  "blacklistDirs": ["migrations", "fixtures"],
  "maxTokensPerFile": 600,
  "maxContextTokens": 8000,
  "recentWindowHours": 48,
  "semanticCompression": {
    "enabled": false,
    "ratio": 0.5
  }
}
```

| Key | Default | Description |
|---|---|---|
| `whitelistDirs` | — | Only index/return files from these dirs |
| `blacklistDirs` | — | Extra dirs to skip (merged with built-in skips) |
| `maxTokensPerFile` | `600` | Files above this get skeleton treatment |
| `maxContextTokens` | `8000` | Total token budget for `get_context` |
| `recentWindowHours` | `48` | "Recently touched" threshold |

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

## HTTP daemon & auto-sync

Lucid can run as a background HTTP daemon (port 7821) for auto-syncing files without Claude's cooperation.

```bash
# Start daemon (watches for sync requests, serves REST API)
lucid watch

# With HTTP server
lucid watch --http

# Check status
lucid status

# Stop
lucid stop
```

### REST API (when `--http` is active)

| Endpoint | Description |
|---|---|
| `POST /sync` `{ path }` | Sync a single file |
| `POST /sync-project` `{ directory? }` | Sync entire project |
| `GET /context?q=<query>` | Get context via HTTP |
| `POST /validate` `{ path }` | Validate file for drift |
| `GET /health` | Daemon health check |

### Auto-sync hook (`lucid-sync`)

`init_project` installs a Claude Code `PostToolUse` hook that calls `lucid-sync` after every file write/edit. The sync binary:

1. Tries HTTP sync (500ms timeout, if daemon running)
2. Falls back to direct SQLite sync (no daemon needed)

This keeps the knowledge graph current automatically — without relying on Claude remembering to call `sync_file`.

## Skills enforcement

Lucid ships **enforcement skills** that install globally into `~/.claude/skills/` and activate in every project:

| Skill | Purpose |
|---|---|
| `lucid-start` | Session start — `get_recent` + `smart_context` before any coding |
| `lucid-context` | Pre-task context loading — `suggest_model` + `smart_context` |
| `lucid-audit` | Pre-done gate — validate + check drift before marking complete |
| `lucid-plan` | Planning workflow |
| `lucid-sync` | Post-edit sync reminder |
| `lucid-webdev` | Web dev workflow with context |

All skills use `<HARD-GATE>` blocks that prevent proceeding until required tools are called.

Install globally:
```bash
init_project()   # installs skills to ~/.claude/skills/ automatically
```

## Debugging

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2024-11-05"}}' \
  | npx @a13xu/lucid
```

In Claude Code: run `/mcp` — you should see `lucid` with 37 tools.

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
- **Compression:** Node.js built-in `zlib` (deflate level 9) + LLMLingua-2 semantic compression (optional)
- **Hashing:** SHA-256 via `crypto` (change detection)
- **Ranking:** TF-IDF (built-in) or Qdrant (optional, via REST)
- **Semantic compression:** `@huggingface/transformers` (ONNX Runtime, q8 quantization)
- **HTTP daemon:** Express 5 on port 7821 (optional)
- **File watcher:** `chokidar`
- **Validation:** `zod`
- **Transport:** stdio
