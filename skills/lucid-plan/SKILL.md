---
name: lucid-plan
description: MANDATORY before writing code for any non-trivial feature — creates a persisted plan with tasks. HARD-GATE: no coding without a plan.
argument-hint: "[feature or task description]"
allowed-tools:
  - mcp__lucid__suggest_model
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

<HARD-GATE>
You are about to write code for a feature or fix.
STOP. Create a plan first. Plans survive session restarts.
Do NOT write implementation code until a plan exists and tasks are defined.
</HARD-GATE>

## When to invoke

**INVOKE when:** implementing a feature, fixing a non-trivial bug, any task with 3+ steps
**DO NOT INVOKE for:** single-line fixes, config changes, documentation-only tasks

## Steps

### 0. Get model recommendation
```
suggest_model(task_description="<paste the user's task description>")
```
Say: **"Using [model] — [reasoning]"** then proceed.

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
