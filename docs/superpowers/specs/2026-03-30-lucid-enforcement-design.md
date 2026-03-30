# Lucid Enforcement — Design Spec (v1.14.0)

**Date:** 2026-03-30
**Status:** Approved
**Problem:** Claude ignores Lucid directives (sync_file, get_context, validate_file) even when CLAUDE.md and skills instruct it to use them. The PostToolUse hook only echoes a reminder — Claude can and does ignore it. sync_file is an MCP tool, not callable from a shell hook.

---

## Goal

Make Lucid usage **unavoidable** through three layers of enforcement:

1. **Auto-sync** — file changes are indexed automatically, no Claude action required
2. **HTTP daemon** — shell hooks can call Lucid directly without going through Claude
3. **Plugin global + skills** — enforcement at the AI layer via superpowers-style hard gates

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 ~/.claude/plugins/lucid/             │
│  plugin global — SessionStart skill + 5 skills      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│              MCP Server (@a13xu/lucid)              │
│  20 tools: sync_file, get_context, recall…          │
│                  SQLite DB                          │
└────────┬─────────────────────────┬──────────────────┘
         ▲                         ▲
         │ MCP (stdio)             │ HTTP REST
         │                         │ localhost:7821
┌────────┴──────────┐   ┌──────────┴──────────────────┐
│   Claude Code     │   │    lucid-sync.mjs (hook)    │
│   (skill calls    │   │    PostToolUse → POST /sync  │
│    MCP tools)     │   │    → instant indexing        │
└───────────────────┘   └─────────────────────────────┘
                                   ▲
                        ┌──────────┴──────────────────┐
                        │   lucid watch (daemon)      │
                        │   chokidar file watcher     │
                        │   → POST /sync on change    │
                        └─────────────────────────────┘
```

---

## Component 1: HTTP Server (`src/http/`)

### Endpoints (port 7821, configurable)

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `POST` | `/sync` | `{ "path": "/abs/path/file.ts" }` | `{ ok, indexed, sha256 }` |
| `POST` | `/sync-project` | `{ "dir": "/abs/path" }` | `{ ok, count }` |
| `GET` | `/context` | `?q=...&maxTokens=4000` | `{ files[], tokens }` |
| `POST` | `/validate` | `{ "path": "...", "lang": "auto" }` | `{ issues[] }` |
| `GET` | `/health` | — | `{ ok, version, db }` |

**Key constraint:** All endpoints reuse exact same handlers from `src/tools/` — zero logic duplication. The HTTP layer is a thin adapter only.

**Files:**
- `src/http/server.ts` — Express server, starts on demand
- `src/http/routes.ts` — route definitions wiring to existing handlers

---

## Component 2: `lucid watch` Daemon (`src/cli.ts`)

### CLI interface

```bash
lucid watch [dir]        # watch current dir or specified dir
lucid watch --port 7822  # custom port
lucid watch --no-http    # watcher only, sync direct to SQLite
lucid status             # check if daemon is running (reads PID file)
lucid stop               # stop daemon gracefully
```

### Behavior

- **Startup:** HTTP server UP → chokidar watch on `dir`
- **On file change:** debounce 300ms → `POST /sync`
- **Ignored paths:** `node_modules`, `.git`, `build/`, `dist/`, `*.d.ts`
- **Shutdown:** `Ctrl+C` / `SIGTERM` → graceful shutdown, WAL checkpoint
- **PID file:** `~/.lucid/watch.pid` — used by `lucid status` / `lucid stop`

---

## Component 3: `lucid-sync` Hook Script (`src/lucid-sync.ts`)

Standalone script, exported as `build/lucid-sync.js` and as `lucid-sync` global binary.

### Fallback chain

```
PostToolUse hook calls: lucid-sync $LUCID_TOOL_FILE

1. Try HTTP: POST http://localhost:7821/sync { path } — timeout 500ms
   ✓ Daemon running → fast, returns immediately

2. Fallback: direct SQLite write
   Import database.js + indexer/file.js
   Index file directly into DB

→ Sync is GUARANTEED regardless of daemon state
```

### Hook format (installed by init_project)

```json
{
  "matcher": "Write|Edit|NotebookEdit",
  "hooks": [{
    "type": "command",
    "command": "lucid-sync \"${LUCID_TOOL_INPUT_PATH}\" 2>/dev/null || true"
  }]
}
```

> **Note:** Claude Code PostToolUse hooks receive tool input as JSON on stdin and expose `LUCID_TOOL_INPUT_PATH` — `lucid-sync.ts` must read from stdin (JSON parse `tool_input.path` / `tool_input.file_path`) if the env var approach is not available. The script must handle both patterns.

---

## Component 4: Global Plugin + Skills

### Plugin location

```
~/.claude/plugins/lucid/
├── manifest.json
└── skills/
    ├── lucid-start/SKILL.md     ← NEW: SessionStart enforcement
    ├── lucid-context/SKILL.md   ← rewritten superpowers-style
    ├── lucid-audit/SKILL.md     ← rewritten superpowers-style
    ├── lucid-plan/SKILL.md      ← rewritten superpowers-style
    └── lucid-webdev/SKILL.md    ← rewritten superpowers-style
```

`init_project` installs to `~/.claude/plugins/lucid/` once, globally. Active in **every** project without requiring per-project `init_project`.

Also keeps per-project install in `.claude/skills/` as fallback.

### `lucid-start` skill (new)

The primary enforcement skill. Triggers at session start, blocks any action until Lucid context is loaded:

```markdown
<HARD-GATE>
Do NOT read any file, write any code, or answer any coding question
until all steps below are complete. Non-negotiable.
</HARD-GATE>

Steps:
1. get_recent(hours=24)           — see what changed
2. recall(query="project overview") — reload context
3. If task described: get_context(query="<task>")
4. Announce: "Lucid active ✓ — context loaded"

After EVERY Write/Edit: sync_file(path="<file>") IMMEDIATELY.
```

### Rewritten skills pattern

All 5 skills get:
- **HARD-GATE** with explicit trigger condition
- **TodoWrite checklist** (one task per step)
- **dot-graph flow diagram**
- **Explicit trigger/no-trigger conditions**

---

## `init_project` changes

```typescript
// Install globally (once per machine)
installGlobalPlugin(homeDir);   // ~/.claude/plugins/lucid/

// Install per-project (as before)
installSkills(projectDir);      // .claude/skills/

// Install updated hook with lucid-sync binary
installHooks(projectDir);       // uses lucid-sync binary instead of echo
```

---

## `package.json` changes

```json
{
  "bin": {
    "lucid": "./build/index.js",
    "lucid-sync": "./build/lucid-sync.js"
  },
  "dependencies": {
    "chokidar": "^3.6.0"
  }
}
```

---

## Files to create / modify

| File | Action |
|------|--------|
| `src/http/server.ts` | create |
| `src/http/routes.ts` | create |
| `src/cli.ts` | create |
| `src/lucid-sync.ts` | create |
| `src/tools/init.ts` | modify — global plugin install |
| `skills/lucid-start/SKILL.md` | create |
| `skills/lucid-context/SKILL.md` | modify — superpowers-style |
| `skills/lucid-audit/SKILL.md` | modify — superpowers-style |
| `skills/lucid-plan/SKILL.md` | modify — superpowers-style |
| `skills/lucid-webdev/SKILL.md` | modify — superpowers-style |
| `skills/lucid-security/SKILL.md` | modify — superpowers-style |
| `package.json` | modify — bin + chokidar |

---

## Version

**v1.14.0** — single release delivering all components.

Priority delivery order:
1. Skills rescrise + plugin global (immediate enforcement, no server changes)
2. `lucid-sync.ts` + updated hook (auto-sync)
3. HTTP server + `lucid watch` daemon (full automation)
