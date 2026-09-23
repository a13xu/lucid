---
name: lucid-plan
description: Create and track a persisted Lucid plan (tasks with test criteria) that survives session restarts and drives the status bar. Use when starting a feature or fix with three or more steps, or work that may span sessions.
argument-hint: "[feature or task description]"
allowed-tools:
  - mcp__lucid__plan_create
  - mcp__lucid__plan_list
  - mcp__lucid__plan_get
  - mcp__lucid__plan_update_task
  - mcp__lucid__plan_archive
  - mcp__lucid__plan_delete
  - mcp__lucid__plan_cleanup
  - mcp__lucid__smart_context
  - mcp__lucid__recall
  - mcp__lucid__remember
---

A plan persists in Lucid's database, so a later session (or the user, through the
status bar and `/tasks`) can see what was intended, what is done, and what is stuck.
Create one before implementing work with three or more steps; skip it for one-line
fixes, config tweaks, and documentation-only changes.

## Steps

### 1. Create the plan
```
plan_create(
  title="<short descriptive title>",
  description="<what this accomplishes>",
  user_story="As a <user>, I want <goal>, so that <benefit>.",
  tasks=[
    { title: "Task 1", description: "...", test_criteria: "How to verify it's done" },
    { title: "Task 2", description: "...", test_criteria: "..." },
  ]
)
```
Returns the `plan_id` and one real task id per task, printed as
`[TASK 1 #42 pending] ...`. **Use those ids verbatim** — they are database
rowids, not derived from the plan id, and cannot be computed.

The plan is stamped with the current project automatically. If other plans are
already active here, `plan_create` lists them — close the stale ones rather than
letting them pile up.

### 2. Mark tasks in progress / done as you work
```
plan_update_task(task_id=42, status="in_progress")
plan_update_task(task_id=42, status="done", note="Decision made: used X instead of Y")
```
Notes are append-only, so earlier ones are never lost.

### 3. Resume a session
```
plan_list()                  # active plans for THIS project
plan_list(scope="all")       # every project
plan_get(plan_id=1)          # full details + task ids + status + notes
```

### 4. Close the plan

A plan auto-completes only when **every** task is `done` — both `blocked` and
`in_progress` count as remaining. `plan_update_task` prints what is still open,
so a plan that will not close tells you exactly which task holds it.

When work is dropped, or a task is stuck with no path forward:
```
plan_archive(plan_id=1, status="abandoned", reason="<why>")
plan_archive(plan_id=1, status="active")     # reopen
```
**Never mark an unfinished task `done` just to make the plan close.** Archiving
preserves each task's real status; falsifying one writes a lie into the history
that a later session will read as fact.

Housekeeping:
```
plan_cleanup(stale_hours=72, dry_run=true)   # preview idle active plans
plan_delete(plan_id=1, confirm=true)         # permanent, cascades to tasks
```

## Task statuses: `pending` → `in_progress` → `done` | `blocked`
