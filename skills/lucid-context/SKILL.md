---
name: lucid-context
description: Use before starting any coding task — retrieves minimal relevant context via Lucid's TF-IDF retrieval, then rewards or penalizes based on usefulness.
argument-hint: "[what you are working on]"
---

# Lucid Context Retrieval

Use this skill at the START of every coding task to get only the relevant files instead of reading the whole codebase.

## Steps

1. **Call `get_context`** with a concise description of what you're working on:
   ```
   get_context(query="<what you are working on>", maxTokens=4000)
   ```

2. **Review the returned skeletons/files.** If they are relevant → call `reward()`. If they missed important files → call `penalize()` and note what was missing.

3. **Start coding** using the context you received.

## Tips

- Use `dirs` to narrow scope: `get_context(query="...", dirs=["src/api"])`
- Use `get_recent(hours=2)` after a git pull or when resuming a session to see what changed
- Use `grep_code(pattern="...")` to locate specific function usages without reading full files
- After finishing, call `sync_file(path="<modified file>")` to keep the knowledge graph current

## When to reward vs penalize

| Situation | Action |
|---|---|
| Context included the files that helped solve the task | `reward()` |
| Context missed key files you had to find manually | `penalize(note="missed: src/utils/auth.ts")` |
| Context was partially useful | No action needed |
