---
name: lucid-security
description: Run before merging any code that handles user input, auth, or external data — security scan + drift check for injection, XSS, and credential exposure.
argument-hint: "[file path or directory]"
---

<HARD-GATE>
Before merging code that:
- Handles user input (forms, query params, file uploads)
- Implements auth, tokens, sessions, or permissions
- Calls external APIs or parses external data
- Manages files or runs shell commands

Run this skill. No exceptions.
</HARD-GATE>

## Steps

### 1. Security scan
```
security_scan(code="<file contents or snippet>", language="typescript", context="backend")
```

### 2. Drift check for security-sensitive snippets
```
check_drift(code="<auth/input-handling code>", language="typescript")
```

### 3. Fix all CRITICAL issues before merging

| Severity | Action |
|---|---|
| 🔴 CRITICAL | Block merge — fix immediately |
| 🟠 HIGH | Fix before merge |
| 🔵 MEDIUM/LOW | Track, fix in follow-up |
