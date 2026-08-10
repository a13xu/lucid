---
description: Drill-down — task-urile planului activ din Lucid (bara de status 📋)
allowed-tools: Bash(node:*)
---

## Context

Task-urile planului activ din Lucid, pentru proiectul curent:

!`node "__CLAUDE_DIR__/lucid-tasks.mjs" $ARGUMENTS`

## Instrucțiuni

Afișează output-ul de mai sus utilizatorului, formatat curat (păstrează iconițele
de status). Nu adăuga analiză sau comentarii — este un drill-down rapid al
segmentului 📋 din bara de status. Dacă utilizatorul a pasat `--all`, include și
planurile finalizate.
