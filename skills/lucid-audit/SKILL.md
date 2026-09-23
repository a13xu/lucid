---
name: lucid-audit
description: Validate changed code with Lucid's Logic Guardian (drift patterns) and Code Quality checks before calling it done, committing, or opening a PR. Use after implementing a feature, fix, or refactor.
argument-hint: "[file path or 'all changed files']"
allowed-tools:
  - mcp__lucid__validate_file
  - mcp__lucid__check_drift
  - mcp__lucid__get_checklist
  - mcp__lucid__check_code_quality
  - mcp__lucid__coding_rules
  - mcp__lucid__get_recent
  - Read
  - Glob
---

Code that looks right can still invert a condition, miss a boundary, or leave a
copy-pasted name stale. The validators catch the mechanical share of those mistakes
cheaply, so run them on every file you changed before reporting the work as done.
Skip this for read-only work, research, or changes with no logic in them.

1. `validate_file(path)` on each changed file (`get_recent` lists them if needed).
   Fix every 🔴 critical finding and re-run until none remain.
2. `check_code_quality(path)` on the same files. Fix 🔴 high findings, fix 🟠 medium
   ones where the change is safe, and leave 🔵 low for later.
3. For intricate logic, `get_checklist()` gives the five-pass manual review (trace
   concrete inputs, contracts, common drift patterns, integration, one-sentence
   explanation). For a snippet not yet on disk, use `check_drift(code, language)`.

In your summary, list what you ran and what you fixed, and say plainly if a check
could not run.
