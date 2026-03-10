---
name: lucid-plan
description: Create and track an implementation plan before writing any code — use Lucid's planning tools to define user story, ordered tasks, and test criteria.
argument-hint: "[feature or task description]"
---

# Lucid Planning Workflow

Use this skill BEFORE writing code for any non-trivial feature. Plans are persisted in the Lucid DB and survive session restarts.

## Steps

### 1. Create the plan
```
plan_create(
  title="<short title>",
  description="<what this plan accomplishes>",
  user_story="As a <user>, I want <goal>, so that <benefit>.",
  tasks=[
    { title: "Task 1", description: "...", test_criteria: "How to verify done" },
    { title: "Task 2", description: "...", test_criteria: "..." },
  ]
)
```
Returns a `plan_id` and task IDs (format: `planId * 100 + sequence`).

### 2. Work through tasks
For each task, mark it in progress when you start:
```
plan_update_task(task_id=101, status="in_progress")
```

When done, mark it complete (optionally add a note):
```
plan_update_task(task_id=101, status="done", note="Used useFetch instead of axios")
```

Plan auto-completes when all tasks reach `done`.

### 3. Resume a session — check plan status
```
plan_list()                  # see all active plans
plan_get(plan_id=1)          # see full details + task status
```

## Task statuses

| Status | When to use |
|---|---|
| `pending` | Not started yet |
| `in_progress` | Currently working on it |
| `done` | Completed and verified |
| `blocked` | Waiting on external dependency |

## Tips

- Define `test_criteria` clearly — it becomes your acceptance test
- Use `plan_get` when resuming to quickly re-orient yourself
- Keep tasks small (1–4 hours each); use more tasks rather than fewer
- Notes are append-only — use them to document decisions made during implementation
