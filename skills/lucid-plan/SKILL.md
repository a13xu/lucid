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
Returns a `plan_id` and task IDs (format: `planId * 100 + sequence`).

### 2. Mark tasks in progress / done as you work
```
plan_update_task(task_id=101, status="in_progress")
plan_update_task(task_id=101, status="done", note="Decision made: used X instead of Y")
```

### 3. Resume a session
```
plan_list()           # all active plans
plan_get(plan_id=1)   # full details + task status
```

## Task statuses: `pending` → `in_progress` → `done` | `blocked`
