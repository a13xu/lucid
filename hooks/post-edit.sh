#!/usr/bin/env bash
# Lucid PostToolUse hook — auto sync + Logic Guardian after Write/Edit/NotebookEdit
#
# Claude Code passes tool input as JSON on stdin.
# This is the PRIMARY source for file_path; git diff is only a fallback.
#
# Install: run  bash lucid/install.sh  and choose "Install Claude Code hooks"
# Or add manually to .claude/settings.json:
#   "PostToolUse": [{"matcher": "Write|Edit|NotebookEdit",
#                    "hooks": [{"type":"command","command":"bash /abs/path/lucid/hooks/post-edit.sh"}]}]

LUCID_API="${LUCID_API:-http://localhost:3001}"

# ---------------------------------------------------------------------------
# 0. Resolve Python binary (python3 on Linux/macOS, python on Windows)
# ---------------------------------------------------------------------------
# Test actual execution (Windows has a python3 Store stub that exists but fails)
if python3 -c "print(1)" > /dev/null 2>&1; then PY=python3
elif python -c "print(1)"  > /dev/null 2>&1; then PY=python
else PY=""; fi

# ---------------------------------------------------------------------------
# 1. Extract file path from stdin (Claude Code passes tool_input as JSON)
# ---------------------------------------------------------------------------
INPUT=$(cat)

[ -z "$PY" ] && exit 0

FILE_PATH=$(echo "$INPUT" | $PY -c \
'import sys,json
try:
    d=json.load(sys.stdin)
    ti=d.get("tool_input",{})
    print((ti.get("file_path") or ti.get("notebook_path") or "").strip())
except Exception:
    pass' 2>/dev/null)

# ---------------------------------------------------------------------------
# 2. Fallback: git diff for the most recently modified tracked file
# ---------------------------------------------------------------------------
if [ -z "$FILE_PATH" ]; then
    GIT_FILE=$(git diff --name-only 2>/dev/null | head -1)
    if [ -n "$GIT_FILE" ]; then
        FILE_PATH="$(git rev-parse --show-toplevel 2>/dev/null)/$GIT_FILE"
    fi
fi

[ -z "$FILE_PATH" ] && exit 0

# ---------------------------------------------------------------------------
# 3. Check Lucid API is running (fail silently if not)
# ---------------------------------------------------------------------------
curl -sf --max-time 1 "$LUCID_API/api/auto/ping" > /dev/null 2>&1 || exit 0

# ---------------------------------------------------------------------------
# 4. JSON-encode the path (handles spaces, backslashes, special chars)
# ---------------------------------------------------------------------------
PATH_JSON=$($PY -c "import json,sys; print(json.dumps(sys.argv[1]))" "$FILE_PATH" 2>/dev/null)
[ -z "$PATH_JSON" ] && exit 0

# ---------------------------------------------------------------------------
# 5. Sync file into knowledge graph
# ---------------------------------------------------------------------------
SYNC_RESPONSE=$(curl -sf --max-time 10 -X POST "$LUCID_API/api/auto/sync-file" \
    -H "Content-Type: application/json" \
    -d "{\"path\": $PATH_JSON}" 2>/dev/null)

SYNC_RESULT=$(echo "$SYNC_RESPONSE" | $PY -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('result',''))" 2>/dev/null)
[ -n "$SYNC_RESULT" ] && echo "$SYNC_RESULT"

# ---------------------------------------------------------------------------
# 6. Logic Guardian validation (code files only)
# ---------------------------------------------------------------------------
EXT="${FILE_PATH##*.}"
case "$EXT" in
    ts|tsx|js|jsx|py|go|rs|vue)
        VALIDATE_RESPONSE=$(curl -sf --max-time 15 -X POST "$LUCID_API/api/auto/validate-file" \
            -H "Content-Type: application/json" \
            -d "{\"path\": $PATH_JSON}" 2>/dev/null)

        VALIDATE_RESULT=$(echo "$VALIDATE_RESPONSE" | $PY -c \
            "import sys,json; d=json.load(sys.stdin); print(d.get('result',''))" 2>/dev/null)

        # Only surface warnings/errors — skip clean passes to reduce noise
        if echo "$VALIDATE_RESULT" | grep -qE "⚠️|❌|ISSUE|WARNING|issue|warning"; then
            echo ""
            echo "🛡️ Logic Guardian (auto):"
            echo "$VALIDATE_RESULT"
        fi
        ;;
esac

exit 0
