---
name: lucid-audit
description: Run after writing or modifying code — validates logic correctness (Logic Guardian 5 passes) and code quality (25 Golden Rules) before marking work as done.
argument-hint: "[file path or 'all']"
---

# Lucid Code Audit

Run this skill BEFORE marking any implementation as complete. It runs two complementary validators:

- **Logic Guardian** (`validate_file`) — detects LLM drift: logic inversions, null propagation, off-by-one, copy-paste mistakes
- **Code Quality Guard** (`check_code_quality`) — detects structural issues: file/function size, vague naming, deep nesting, prop explosion, inline styles

## Steps

### 1. Validate logic correctness
```
validate_file(path="<file you wrote or modified>")
```
Fix any 🔴 CRITICAL issues before continuing.

### 2. Validate code quality
```
check_code_quality(path="<same file>")
```
Fix any 🔴 HIGH severity issues. Address 🟠 MEDIUM where practical.

### 3. If unsure about a snippet before writing it to disk
```
check_drift(code="<your code>", language="typescript")
```

### 4. Get the full 5-pass mental checklist
```
get_checklist()
```
Use this when changes are complex or involve critical business logic.

## Severity guide

| Icon | Level | Action |
|---|---|---|
| 🔴 | Critical/High | Fix immediately — do not ship |
| 🟠 | Medium/Warning | Fix if not risky refactor |
| 🔵 | Low/Info | Note for future cleanup |

## What each tool catches

| Tool | Catches |
|---|---|
| `validate_file` | Logic inversions, silent exceptions, null propagation, type confusion, stale closures |
| `check_code_quality` | Files >500 lines, functions >100 lines, vague names, nesting >4 levels, dead code, React/Vue component anti-patterns |
| `check_drift` | Same as validate_file but on inline snippets — use before writing |
