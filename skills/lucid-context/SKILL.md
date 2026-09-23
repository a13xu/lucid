---
name: lucid-context
description: Load the code and knowledge relevant to a task through Lucid's ranked retrieval (smart_context) instead of broad file searches. Use before working in an unfamiliar part of a Lucid-indexed codebase.
argument-hint: "[what you are working on]"
allowed-tools:
  - mcp__lucid__smart_context
  - mcp__lucid__get_context
  - mcp__lucid__get_recent
  - mcp__lucid__recall
  - mcp__lucid__grep_code
  - mcp__lucid__reward
  - mcp__lucid__penalize
---

`smart_context` combines TF-IDF ranking, recency, reward signals, and skeleton pruning, so
one call usually returns what several searches and full-file reads would, in fewer
tokens. When you already know the exact file or symbol, read it directly instead.

## Retrieve

```
smart_context(query="<what you are working on>", task_type="moderate")
smart_context(query="...", dirs=["src/api"], task_type="simple")   # narrower, cheaper
```

For follow-ups: `grep_code(pattern)` for a symbol's usages, `recall(query)` for what
earlier sessions recorded, `get_recent(hours=2)` after a pull.

## Give feedback

Ranking learns from feedback; without it the same misses repeat.

| Result | Call |
|---|---|
| It included the files you needed | `reward()` |
| You had to find important files yourself | `penalize(note="missed: src/path/file.ts")` |
| Partly useful | nothing |
