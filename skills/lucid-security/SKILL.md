---
name: lucid-security
description: Security scan plus drift check for code that handles user input, auth, external data, files, or shell commands — injection, XSS, and credential exposure. Use before merging such code.
argument-hint: "[file path or directory]"
allowed-tools:
  - mcp__lucid__security_scan
  - mcp__lucid__check_drift
  - mcp__lucid__validate_file
  - mcp__lucid__get_recent
  - mcp__lucid__grep_code
  - Read
  - Glob
---

Run this on code that handles user input (forms, query params, uploads); implements
auth, tokens, sessions, or permissions; calls external APIs or parses external data; or
touches files or shell commands. Those are the paths where a small mistake becomes an
exploitable one.

1. `security_scan(code, language, context)`, where `context` is e.g. `"backend"` or
   `"frontend"`.
2. `check_drift(code, language)` on the auth and input-handling parts.
3. Act on severity:

| Severity | Action |
|---|---|
| 🔴 Critical | Fix before merging |
| 🟠 High | Fix before merging |
| 🔵 Medium / low | Track and fix in a follow-up |
