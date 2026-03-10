---
name: lucid-security
description: Run a full security review on a file or snippet — combines web vulnerability scanning (XSS, injection, secrets) with LLM drift detection before shipping code.
argument-hint: "[file path or paste code]"
---

# Lucid Security Review

Run this skill before shipping any code that handles user input, authentication, file access, or external data.

## Steps

### 1. Scan for web security vulnerabilities
```
security_scan(
  code="<file contents or snippet>",
  language="typescript",    # javascript | typescript | html | vue
  context="backend"         # frontend | backend | api
)
```
Detects: XSS vectors, eval/new Function, SQL injection via string concat, hardcoded secrets/keys, open redirects, prototype pollution, path traversal, insecure CORS.

### 2. Scan for logic errors (LLM drift)
```
validate_file(path="<file path>")
```
Catches security-adjacent logic bugs: wrong condition direction, silent exception swallowing, null propagation into auth checks.

### 3. For frontend components — audit accessibility too
```
accessibility_audit(code="<template or JSX>", wcag_level="AA", framework="vue")
```

## Severity guide

| Icon | Severity | Action |
|---|---|---|
| 🔴 Critical | XSS, eval, hardcoded secret, SQL injection | Fix before any commit |
| 🟠 High | Open redirect, path traversal, prototype pollution | Fix before merge |
| 🟡 Medium | Wildcard CORS, missing CSRF protection | Fix before production |
| 🔵 Low | console.log, minor info leakage | Fix when convenient |

## Common patterns to watch

| Pattern | Risk |
|---|---|
| `element.innerHTML = userInput` | XSS — use `textContent` or DOMPurify |
| `eval(...)` / `new Function(...)` | Code injection |
| `const key = "sk-abc123..."` | Hardcoded secret — move to env var |
| `res.redirect(req.query.url)` | Open redirect — validate against allowlist |
| `readFile(req.params.filename)` | Path traversal — use `path.resolve` + bounds check |
| `Access-Control-Allow-Origin: *` | Overly permissive CORS |

## Note

Static scanning finds patterns, not all vulnerabilities. Complement with:
- Manual code review for business logic flaws
- DAST (dynamic testing) for runtime issues
- Dependency audit: `npm audit` / `pip-audit`
