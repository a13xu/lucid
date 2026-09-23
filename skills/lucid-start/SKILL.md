---
name: lucid-start
description: Orient at the start of a coding session in a Lucid-indexed project — shows what changed recently and loads context for the task. Use when a session begins with code work, or when resuming after a break.
argument-hint: "[optional: what you are about to work on]"
allowed-tools:
  - mcp__lucid__init_project
  - mcp__lucid__sync_project
  - mcp__lucid__memory_stats
  - mcp__lucid__recall
  - mcp__lucid__get_recent
  - mcp__lucid__smart_context
---

Lucid keeps an index of the project and a knowledge graph of what earlier sessions
learned. Checking both first means you start from what is already known instead of
rediscovering it file by file.

1. `get_recent(hours=48)` — files changed since the last sessions, with line diffs.
   Skim it for anything that affects the task.
2. If there is a task, `smart_context(query="<the task>", task_type="moderate")` —
   ranked code plus relevant knowledge-graph notes in one call.
3. If the project has never been indexed (`memory_stats` shows no files for it), run
   `init_project()` once.

Keeping the index current: edits made with Write/Edit/NotebookEdit are synced by the
`lucid-sync` hook that `init_project` installs. Changes made any other way — `git pull`,
codegen, edits through Bash — are not; call `sync_project()` after those.

Before calling a change done, `/lucid-audit` runs the validators.
