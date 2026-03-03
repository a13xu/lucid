#!/usr/bin/env bash
# Lucid MCP Server — Installer
# Usage: bash install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Lucid MCP Server — Installer       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# 1. Build MCP server
# ---------------------------------------------------------------------------
echo "▶ Installing MCP server dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
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

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   ✅  Instalare completă!             ║"
echo "╚══════════════════════════════════════╝"
echo ""
