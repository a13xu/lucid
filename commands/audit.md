Run a comprehensive code audit on recently changed files using Lucid's Logic Guardian (5-pass validation) and Coding Rules (25 Golden Rules).

Steps:
1. Find recently modified source files:
   - Run `git diff --name-only HEAD` to get unstaged changes
   - Run `git diff --name-only --cached` to get staged changes
   - Combine and deduplicate; focus on .ts/.tsx/.js/.jsx/.py/.vue/.go/.rs files
2. For each modified source file:
   a. Call `mcp__lucid__validate_file` with the absolute file path
   b. Call `mcp__lucid__check_code_quality` with the absolute file path
3. Collect all findings, group by severity:
   - 🔴 HIGH — must fix before merging
   - 🟠 MEDIUM — should fix
   - 🔵 LOW — consider fixing
4. For each HIGH issue: show the exact location and suggest a concrete fix
5. Summary: X issues found (H high, M medium, L low)

If no git repo: audit the files from the last Write/Edit tool calls instead.
