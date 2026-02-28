/**
 * WAF (Web Application Firewall) rules for MCP tool inputs.
 *
 * Covers:
 *  - Path traversal & directory escape
 *  - Null-byte & CRLF injection
 *  - ReDoS (catastrophic backtracking) detection
 *  - Input size limits (DoS prevention)
 *  - Suspicious injection patterns (SQLi, command injection)
 *  - Sensitive data leakage in outputs
 */

import { resolve, normalize } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "low" | "medium" | "high" | "critical";

export interface WafViolation {
  rule: string;
  severity: Severity;
  detail: string;
}

export interface WafResult {
  blocked: boolean;
  violations: WafViolation[];
}

const PASS: WafResult = { blocked: false, violations: [] };

function block(rule: string, severity: Severity, detail: string): WafResult {
  return { blocked: true, violations: [{ rule, severity, detail }] };
}

// ---------------------------------------------------------------------------
// Input size limits
// ---------------------------------------------------------------------------

const MAX_LENGTHS: Record<string, number> = {
  query:       2_000,
  pattern:     500,
  path:        1_000,
  code:        200_000,   // check_drift: allow large snippets
  observation: 10_000,
  entity:      500,
  command:     2_000,
  default:     50_000,
};

export function checkSize(field: string, value: string): WafResult {
  const limit = MAX_LENGTHS[field] ?? MAX_LENGTHS["default"]!;
  if (value.length > limit) {
    return block(
      "SIZE_LIMIT",
      "medium",
      `Field "${field}" exceeds max length (${value.length} > ${limit})`
    );
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// Null-byte & CRLF injection
// ---------------------------------------------------------------------------

export function checkInjection(value: string): WafResult {
  if (value.includes("\0")) {
    return block("NULL_BYTE", "high", "Null byte detected in input");
  }
  if (/\r\n|\r/.test(value) && value.includes("HTTP/")) {
    return block("CRLF_INJECTION", "high", "CRLF injection pattern detected");
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

// Normalize and verify path stays within an allowed root
export function checkPath(inputPath: string, allowedRoot?: string): WafResult {
  const injection = checkInjection(inputPath);
  if (injection.blocked) return injection;

  // Detect traversal patterns before resolution
  if (/\.\.[/\\]/.test(inputPath) || inputPath.includes("..%2F") || inputPath.includes("..%5C")) {
    return block("PATH_TRAVERSAL", "critical", "Directory traversal sequence detected");
  }

  // Detect absolute paths to sensitive OS locations
  const normalized = normalize(inputPath).replace(/\\/g, "/");
  const sensitiveRoots = ["/etc/", "/proc/", "/sys/", "/dev/", "/root/",
                          "C:/Windows/", "C:\\Windows\\"];
  for (const root of sensitiveRoots) {
    if (normalized.toLowerCase().startsWith(root.toLowerCase())) {
      return block("SENSITIVE_PATH", "critical", `Access to sensitive system path blocked`);
    }
  }

  // If an allowed root is provided, verify path stays within it
  if (allowedRoot) {
    const resolvedPath = resolve(inputPath);
    const resolvedRoot = resolve(allowedRoot);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      return block(
        "PATH_ESCAPE",
        "critical",
        `Path escapes allowed root (${resolvedRoot})`
      );
    }
  }

  return PASS;
}

// ---------------------------------------------------------------------------
// ReDoS detection (for regex inputs in grep_code)
// ---------------------------------------------------------------------------

// Patterns that indicate catastrophic backtracking risk
const REDOS_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\([^)]*[+*][^)]*\)[+*{]/,         name: "nested-quantifier" },     // (a+)+
  { re: /\([^)]*\|[^)]*\)[+*{]/,           name: "alternation-quantifier" }, // (a|b)+
  { re: /[+*]\s*[+*]/,                      name: "consecutive-quantifiers" },// .* .*
  { re: /\{[0-9]{3,},/,                     name: "large-repetition" },       // {1000,}
  { re: /(\(\?[^)]*\)){3,}/,               name: "excessive-lookahead" },     // (?=...)(?=...)(?=...)
];

export function checkReDoS(pattern: string): WafResult {
  for (const { re, name } of REDOS_PATTERNS) {
    if (re.test(pattern)) {
      return block("REDOS", "high", `Regex pattern may cause catastrophic backtracking (rule: ${name})`);
    }
  }

  // Also attempt to measure compile time as a secondary check
  try {
    const start = Date.now();
    new RegExp(pattern);
    if (Date.now() - start > 100) {
      return block("REDOS", "medium", "Regex compilation was unexpectedly slow");
    }
  } catch (e) {
    return block("INVALID_REGEX", "low", `Invalid regex pattern: ${(e as Error).message}`);
  }

  return PASS;
}

// ---------------------------------------------------------------------------
// Command/SQL injection patterns (defensive — prepared stmts are primary guard)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: Array<{ re: RegExp; rule: string; severity: Severity }> = [
  { re: /;\s*(DROP|DELETE|TRUNCATE|ALTER)\s+/i,    rule: "SQL_INJECTION",     severity: "critical" },
  { re: /UNION\s+(?:ALL\s+)?SELECT/i,              rule: "SQL_UNION",         severity: "high"     },
  { re: /'\s*OR\s+'1'\s*=\s*'1/i,                  rule: "SQL_TAUTOLOGY",     severity: "high"     },
  { re: /`[^`]*`|;\s*[a-z]+\s+\/|&&|\|\|/,        rule: "CMD_INJECTION",     severity: "high"     },
  { re: /\$\([^)]+\)|`[^`]+`/,                     rule: "SHELL_SUBSTITUTION", severity: "high"    },
];

export function checkInjectionPatterns(value: string): WafResult {
  for (const { re, rule, severity } of INJECTION_PATTERNS) {
    if (re.test(value)) {
      return block(rule, severity, `Injection pattern detected (rule: ${rule})`);
    }
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// Sensitive data leak detection (for outbound content)
// ---------------------------------------------------------------------------

const SENSITIVE_LEAK_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/,                       // OpenAI API key
  /AKIA[0-9A-Z]{16}/,                           // AWS access key
  /(?:eyJ)[a-zA-Z0-9_-]{10,}\.(?:eyJ)[a-zA-Z0-9_-]{10,}/, // JWT
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,   // PEM key
  /(?:password|passwd|secret|token)\s*[=:]\s*['"]?[^\s'"]{8,}/i, // generic
];

/** Check if a text blob about to be returned contains secrets. */
export function checkOutputLeakage(text: string): WafViolation[] {
  const violations: WafViolation[] = [];
  for (const pattern of SENSITIVE_LEAK_PATTERNS) {
    if (pattern.test(text)) {
      violations.push({
        rule: "DATA_LEAKAGE",
        severity: "critical",
        detail: "Output may contain sensitive credentials or keys",
      });
      break; // one warning is enough
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Composite check for common string fields
// ---------------------------------------------------------------------------

export function checkStringField(field: string, value: string, opts?: {
  isPath?: boolean;
  isRegex?: boolean;
  allowedRoot?: string;
}): WafResult {
  const size = checkSize(field, value);
  if (size.blocked) return size;

  const inj = checkInjection(value);
  if (inj.blocked) return inj;

  if (opts?.isPath) {
    const path = checkPath(value, opts.allowedRoot);
    if (path.blocked) return path;
  }

  if (opts?.isRegex) {
    const redos = checkReDoS(value);
    if (redos.blocked) return redos;
  }

  return PASS;
}
