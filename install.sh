#!/usr/bin/env bash
# Lucid MCP Server — Installer
# Usage: bash install.sh  (Linux/macOS/Git Bash)
#        .\install.ps1    (Windows PowerShell — rulat automat de pe Windows)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Platform detection — pe Windows delegăm la install.ps1
# ---------------------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected (Git Bash / MSYS) — delegating to install.ps1..."
    powershell -ExecutionPolicy Bypass -File "$SCRIPT_DIR/install.ps1"
    exit $?
    ;;
esac

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Lucid MCP Server — Installer       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# 1. Build MCP server
# ---------------------------------------------------------------------------
echo "▶ Installing MCP server dependencies..."
echo "  (better-sqlite3 compileaza nativ — poate dura 1-2 min, asteptati...)"
cd "$SCRIPT_DIR"
npm install --no-fund --no-audit
echo "▶ Building MCP server..."
npm run build
echo "✅ MCP server built  →  build/index.js"
echo ""

# ---------------------------------------------------------------------------
# 2. Register MCP server with Claude Code (optional)
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null; then
  read -r -p "Register Lucid as Claude Code MCP server? [Y/n] " yn_mcp
  yn_mcp="${yn_mcp:-Y}"
  if [[ "$yn_mcp" =~ ^[Yy]$ ]]; then
    claude mcp add --transport stdio lucid -- node "$SCRIPT_DIR/build/index.js"
    echo "✅ Registered: lucid → node $SCRIPT_DIR/build/index.js"
  else
    echo "⏭️  Skipped MCP registration (run manually later)"
    echo "   claude mcp add --transport stdio lucid -- node \"$SCRIPT_DIR/build/index.js\""
  fi
else
  echo "⚠️  claude CLI not found — register manually after install:"
  echo "   claude mcp add --transport stdio lucid -- node \"$SCRIPT_DIR/build/index.js\""
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Web Dev Cycle Manager (optional)
# ---------------------------------------------------------------------------
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  Web Dev Cycle Manager                                   │"
echo "│  Express API (port 3001) + React/Vite UI (port 5173)     │"
echo "│  Vizualizare planuri, task-uri și HTTP tests din browser │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
read -r -p "Install Web Dev Cycle Manager? [y/N] " yn_web
yn_web="${yn_web:-N}"

if [[ "$yn_web" =~ ^[Yy]$ ]]; then
  WEB_DIR="$SCRIPT_DIR/web"

  if [ ! -d "$WEB_DIR" ]; then
    echo "❌ Directory $WEB_DIR not found"
    exit 1
  fi

  echo ""
  echo "▶ Installing web dependencies (better-sqlite3 va compila nativ — durează ~1-2 min)..."
  cd "$WEB_DIR"
  npm install
  echo "✅ Web dependencies installed"

  echo ""
  read -r -p "Build web for production now? [y/N] " yn_build
  yn_build="${yn_build:-N}"
  if [[ "$yn_build" =~ ^[Yy]$ ]]; then
    npm run build
    echo "✅ Web built  →  dist/client/  +  dist/server/"
  fi

  echo ""
  echo "✅ Web Dev Cycle Manager gata!"
  echo ""
  echo "   Start (development):"
  echo "   Terminal 1:  cd lucid/web && npm run dev:server   # API port 3001"
  echo "   Terminal 2:  cd lucid/web && npm run dev:client   # UI  port 5173"
  echo ""
  echo "   Sau din directorul lucid/:"
  echo "   npm run web:server"
  echo "   npm run web:client"
  echo ""
  if [[ "$yn_build" =~ ^[Yy]$ ]]; then
    echo "   Start (production):"
    echo "   cd lucid/web && npm start                         # API port 3001"
    echo "   Servește static din dist/client/ cu un web server separat"
    echo ""
  fi
else
  echo "⏭️  Web UI skipped"
  echo "   Pentru a instala mai târziu:  bash $SCRIPT_DIR/install.sh"
fi

# ---------------------------------------------------------------------------
# 4. Claude Code Hooks + Skills (optional)
# ---------------------------------------------------------------------------
echo ""
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  Claude Code Hooks & Skills                              │"
echo "│  PostToolUse: auto sync_file + Logic Guardian            │"
echo "│  SessionStart: auto init_project                         │"
echo "│  Skills: /audit, /context                                │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
read -r -p "Install Claude Code hooks for current project? [y/N] " yn_hooks
yn_hooks="${yn_hooks:-N}"

if [[ "$yn_hooks" =~ ^[Yy]$ ]]; then
  # Target project = cwd where install.sh is invoked FROM (parent of lucid/ or explicit path)
  read -r -p "Target project directory [default: current dir]: " TARGET_DIR
  TARGET_DIR="${TARGET_DIR:-$(pwd)}"
  TARGET_DIR="$(realpath "$TARGET_DIR" 2>/dev/null || echo "$TARGET_DIR")"

  CLAUDE_DIR="$TARGET_DIR/.claude"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  COMMANDS_DIR="$CLAUDE_DIR/commands"

  mkdir -p "$CLAUDE_DIR" "$COMMANDS_DIR"

  # Make hook scripts executable
  chmod +x "$SCRIPT_DIR/hooks/post-edit.sh" "$SCRIPT_DIR/hooks/session-start.sh"

  POST_CMD="bash \"$SCRIPT_DIR/hooks/post-edit.sh\""
  SESSION_CMD="bash \"$SCRIPT_DIR/hooks/session-start.sh\""

  # Merge hooks into settings.json using Python
  # Resolve Python binary (test actual execution)
  if python3 -c "print(1)" > /dev/null 2>&1; then _PY=python3
  elif python -c "print(1)" > /dev/null 2>&1;  then _PY=python
  else echo "⚠️  Python not found — hooks not installed"; exit 1; fi

  $_PY - "$SETTINGS_FILE" "$POST_CMD" "$SESSION_CMD" <<'PYEOF'
import sys, json, os

settings_path, post_cmd, session_cmd = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(settings_path) as f:
        settings = json.load(f)
except Exception:
    settings = {}

hooks = settings.setdefault("hooks", {})

# PostToolUse: Write|Edit|NotebookEdit → post-edit.sh
post_hooks = hooks.setdefault("PostToolUse", [])
already = any(
    isinstance(h, dict) and
    h.get("matcher") == "Write|Edit|NotebookEdit" and
    any(c.get("command","").endswith("post-edit.sh")
        for c in h.get("hooks", []))
    for h in post_hooks
)
if not already:
    post_hooks.append({
        "matcher": "Write|Edit|NotebookEdit",
        "hooks": [{"type": "command", "command": post_cmd}]
    })

# SessionStart → session-start.sh
session_hooks = hooks.setdefault("SessionStart", [])
already_session = any(
    isinstance(h, dict) and
    any(c.get("command","").endswith("session-start.sh")
        for c in h.get("hooks", []))
    for h in session_hooks
)
if not already_session:
    session_hooks.append({
        "hooks": [{"type": "command", "command": session_cmd}]
    })

os.makedirs(os.path.dirname(settings_path), exist_ok=True)
with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)

print(f"  Updated: {settings_path}")
PYEOF

  # Install skill commands (/audit, /context)
  cp "$SCRIPT_DIR/commands/audit.md"   "$COMMANDS_DIR/audit.md"
  cp "$SCRIPT_DIR/commands/context.md" "$COMMANDS_DIR/context.md"

  echo "✅ Hooks installed in: $SETTINGS_FILE"
  echo "✅ Skills installed:   $COMMANDS_DIR/audit.md  $COMMANDS_DIR/context.md"
  echo ""
  echo "   PostToolUse (Write|Edit|NotebookEdit) → auto sync + Logic Guardian"
  echo "   SessionStart                          → auto init_project"
  echo "   /audit   → run Logic Guardian + 25 Golden Rules on changed files"
  echo "   /context → get relevant context via TF-IDF retrieval"
else
  echo "⏭️  Hooks skipped"
  echo ""
  echo "   Manual setup — add to .claude/settings.json:"
  echo "   PostToolUse matcher Write|Edit|NotebookEdit:"
  echo "     bash \"$SCRIPT_DIR/hooks/post-edit.sh\""
  echo "   SessionStart:"
  echo "     bash \"$SCRIPT_DIR/hooks/session-start.sh\""
  echo ""
  echo "   Skills: copy lucid/commands/*.md → .claude/commands/"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   ✅  Instalare completă!             ║"
echo "╚══════════════════════════════════════╝"
echo ""
