---
name: lucid-start
description: MANDATORY at every session start and before any coding task — loads project context via Lucid before Claude reads any file or writes any code
argument-hint: "[optional: what you are about to work on]"
---

<HARD-GATE>
You MUST complete ALL steps below BEFORE:
- Reading any source file
- Writing or editing any code
- Answering any coding question
- Creating any plan or task

This is not optional. There are no exceptions. "I'll do it after" is not acceptable.
</HARD-GATE>

## Steps (all mandatory, in order)

### 1. Check what changed recently
```
get_recent(hours=24)
```
This shows files modified since your last session. Review the list.

### 2. Reload project overview
```
recall(query="project overview architecture")
```

### 3. If working on a specific task — load relevant context
```
get_context(query="<describe what you are about to work on>", maxTokens=4000)
```
If the user's request involves code, call get_context. For purely conversational exchanges with zero code involvement, this step may be omitted.

### 4. Announce readiness
Say: "✓ Lucid active — context loaded"

---

## After EVERY file write or edit

Call `sync_file` IMMEDIATELY after the tool call completes:
```
sync_file(path="<exact path of file you just wrote or edited>")
```

**Do this before anything else.** Before the next file. Before the next thought. Now.

If you modified multiple files (refactor, git pull): call `sync_project()` instead.

---

## Before marking any task as done

Run /lucid-audit before saying "done", "fixed", "complete", or "implemented".

---

## Trigger conditions

**USE this skill:**
- At the start of every new conversation
- When resuming work after a break
- When the user says "let's work on X" or similar

**DO NOT USE for:**
- Pure conversation with no code involved
- Answering theoretical questions
