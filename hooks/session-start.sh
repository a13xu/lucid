#!/usr/bin/env bash
# Lucid SessionStart hook — auto init_project at session start
#
# Indexes the current project directory into the Lucid knowledge graph.
# init_project is idempotent: unchanged files are skipped.
#
# Install: run  bash lucid/install.sh  and choose "Install Claude Code hooks"
# Or add manually to .claude/settings.json:
#   "SessionStart": [{"hooks": [{"type":"command","command":"bash /abs/path/lucid/hooks/session-start.sh"}]}]

LUCID_API="${LUCID_API:-http://localhost:3001}"

if python3 -c "print(1)" > /dev/null 2>&1; then PY=python3
elif python -c "print(1)"  > /dev/null 2>&1; then PY=python
else exit 0; fi

curl -sf --max-time 1 "$LUCID_API/api/auto/ping" > /dev/null 2>&1 || exit 0

DIR=$(pwd)
DIR_JSON=$($PY -c "import json,sys; print(json.dumps(sys.argv[1]))" "$DIR" 2>/dev/null)
[ -z "$DIR_JSON" ] && exit 0

RESPONSE=$(curl -sf --max-time 60 -X POST "$LUCID_API/api/auto/init-project" \
    -H "Content-Type: application/json" \
    -d "{\"directory\": $DIR_JSON}" 2>/dev/null)

RESULT=$(echo "$RESPONSE" | $PY -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('result',''))" 2>/dev/null)

[ -n "$RESULT" ] && echo "🧠 Lucid: $RESULT"

exit 0
