import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SecurityScanSchema = z.object({
  code: z.string().describe("Code snippet to scan for security vulnerabilities"),
  language: z
    .enum(["javascript", "typescript", "html", "vue"])
    .describe("Code language"),
  context: z
    .enum(["frontend", "backend", "api"])
    .describe("Execution context (affects which rules apply)"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecSeverity = "critical" | "high" | "medium" | "low";

export interface SecurityIssue {
  line: number;
  severity: SecSeverity;
  category: string;
  message: string;
  remediation: string;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface SecurityRule {
  id: string;
  category: string;
  severity: SecSeverity;
  contexts: Array<"frontend" | "backend" | "api" | "all">;
  pattern: RegExp;
  message: string;
  remediation: string;
}

const RULES: SecurityRule[] = [
  // XSS
  {
    id: "xss-innerhtml",
    category: "XSS",
    severity: "critical",
    contexts: ["frontend", "all"],
    pattern: /\.innerHTML\s*=/g,
    message: "Direct innerHTML assignment is vulnerable to XSS",
    remediation: "Use textContent for text, or DOMPurify.sanitize() before setting innerHTML",
  },
  {
    id: "xss-dangerouslysetinnerhtml",
    category: "XSS",
    severity: "critical",
    contexts: ["frontend", "all"],
    pattern: /dangerouslySetInnerHTML/g,
    message: "dangerouslySetInnerHTML can enable XSS if content is not sanitized",
    remediation: "Sanitize HTML with DOMPurify before using dangerouslySetInnerHTML={{ __html: sanitized }}",
  },
  {
    id: "xss-v-html",
    category: "XSS",
    severity: "critical",
    contexts: ["frontend", "all"],
    pattern: /v-html\s*=/g,
    message: "v-html renders raw HTML and is vulnerable to XSS",
    remediation: "Sanitize with DOMPurify: v-html=\"sanitize(content)\" where sanitize = DOMPurify.sanitize",
  },
  {
    id: "xss-document-write",
    category: "XSS",
    severity: "high",
    contexts: ["frontend", "all"],
    pattern: /document\.write\s*\(/g,
    message: "document.write() can enable XSS and blocks page rendering",
    remediation: "Use DOM manipulation APIs (createElement, appendChild) instead",
  },
  // Injection
  {
    id: "injection-eval",
    category: "Code Injection",
    severity: "critical",
    contexts: ["frontend", "backend", "api", "all"],
    pattern: /\beval\s*\(/g,
    message: "eval() executes arbitrary code — critical injection vulnerability",
    remediation: "Remove eval(). Use JSON.parse() for data, or a proper AST parser for code",
  },
  {
    id: "injection-function-constructor",
    category: "Code Injection",
    severity: "critical",
    contexts: ["frontend", "backend", "api", "all"],
    pattern: /new\s+Function\s*\(/g,
    message: "new Function() is equivalent to eval() — executes arbitrary code",
    remediation: "Avoid dynamic code execution. Use configuration objects or strategy patterns",
  },
  {
    id: "injection-settimeout-string",
    category: "Code Injection",
    severity: "high",
    contexts: ["frontend", "backend", "api", "all"],
    // setTimeout("code", ...) or setInterval("code", ...)
    pattern: /(?:setTimeout|setInterval)\s*\(\s*["'`]/g,
    message: "Passing a string to setTimeout/setInterval is equivalent to eval()",
    remediation: "Use an arrow function: setTimeout(() => yourCode(), delay)",
  },
  {
    id: "injection-sql-concat",
    category: "SQL Injection",
    severity: "critical",
    contexts: ["backend", "api"],
    // String concat into what looks like a SQL query
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[^;]*\+\s*(?:req\.|request\.|params\.|query\.|body\.)/gi,
    message: "String-concatenated SQL query is vulnerable to SQL injection",
    remediation: "Use parameterized queries or a query builder (Knex, Prisma, TypeORM)",
  },
  // Exposed secrets
  {
    id: "secret-hardcoded-key",
    category: "Exposed Secret",
    severity: "critical",
    contexts: ["frontend", "backend", "api", "all"],
    // API key patterns: long hex/base64 strings assigned to a key variable
    pattern: /(?:api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=_\-]{16,}["']/gi,
    message: "Hardcoded secret or API key detected in source code",
    remediation: "Move secrets to environment variables. Use process.env.YOUR_SECRET and add to .gitignore/.env",
  },
  {
    id: "secret-private-key-pem",
    category: "Exposed Secret",
    severity: "critical",
    contexts: ["frontend", "backend", "api", "all"],
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
    message: "Private key material embedded in source code",
    remediation: "Store private keys in environment variables or a secrets manager (AWS Secrets Manager, Vault)",
  },
  // Open redirect
  {
    id: "open-redirect",
    category: "Open Redirect",
    severity: "high",
    contexts: ["backend", "api", "frontend"],
    // redirect() or res.redirect() with user-controlled param
    pattern: /(?:res\.redirect|router\.push|window\.location)\s*\(\s*(?:req\.|request\.|params\.|query\.|body\.|\$route\.)/g,
    message: "Potential open redirect: user-controlled URL used in redirect",
    remediation: "Validate redirect URLs against an allowlist before redirecting",
  },
  // Prototype pollution
  {
    id: "prototype-pollution",
    category: "Prototype Pollution",
    severity: "high",
    contexts: ["backend", "api", "all"],
    pattern: /\[["']__proto__["']\]|\[["']constructor["']\]\s*\[["']prototype["']\]/g,
    message: "Prototype pollution vector detected",
    remediation: "Use Object.create(null) for untrusted data containers, or validate against Object.prototype keys",
  },
  // Unsafe deserialization
  {
    id: "unsafe-deserialize",
    category: "Unsafe Deserialization",
    severity: "high",
    contexts: ["backend", "api"],
    pattern: /require\s*\(\s*["']node-serialize["']\)|unserialize\s*\(/g,
    message: "Unsafe deserialization can lead to remote code execution",
    remediation: "Use JSON.parse() for data exchange. Avoid node-serialize with untrusted input",
  },
  // CSRF
  {
    id: "csrf-no-token",
    category: "CSRF",
    severity: "medium",
    contexts: ["backend", "api"],
    // POST/PUT/DELETE route handler without csrf token check
    pattern: /router\s*\.\s*(?:post|put|patch|delete)\s*\(/g,
    message: "Mutating HTTP route — verify CSRF protection is configured (csurf middleware or SameSite cookies)",
    remediation: "Use csurf middleware or ensure SameSite=Strict/Lax cookie attribute is set for session cookies",
  },
  // Path traversal
  {
    id: "path-traversal",
    category: "Path Traversal",
    severity: "high",
    contexts: ["backend", "api"],
    pattern: /(?:readFile|createReadStream|readFileSync)\s*\([^)]*(?:req\.|request\.|params\.|query\.|body\.)/g,
    message: "File path derived from user input — potential path traversal vulnerability",
    remediation: "Validate and sanitize file paths: use path.resolve() + path.relative() to ensure path stays within allowed directory",
  },
  // Headers
  {
    id: "cors-wildcard",
    category: "Insecure CORS",
    severity: "medium",
    contexts: ["backend", "api"],
    pattern: /Access-Control-Allow-Origin['":\s]*[*]/g,
    message: "Wildcard CORS origin allows any domain to make credentialed requests",
    remediation: "Specify allowed origins explicitly: Access-Control-Allow-Origin: https://yourdomain.com",
  },
];

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

function scanCode(
  code: string,
  language: string,
  context: "frontend" | "backend" | "api",
): SecurityIssue[] {
  const lines = code.split("\n");
  const issues: SecurityIssue[] = [];

  for (const rule of RULES) {
    const appliesToContext =
      rule.contexts.includes("all") || rule.contexts.includes(context);
    if (!appliesToContext) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip comment lines
      if (/^\s*\/\/|^\s*\*|^\s*#/.test(line)) continue;

      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "") + "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        issues.push({
          line: i + 1,
          severity: rule.severity,
          category: rule.category,
          message: rule.message,
          remediation: rule.remediation,
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  const order: Record<SecSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return issues;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const SEV_ICON: Record<SecSeverity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleSecurityScan({ code: 'element.innerHTML = userInput;', language: "javascript", context: "frontend" })

export function handleSecurityScan(args: z.infer<typeof SecurityScanSchema>): string {
  const { code, language, context } = args;
  const issues = scanCode(code, language, context);

  if (issues.length === 0) {
    return (
      `✅ No security issues found (${language}, ${context} context).\n\n` +
      `💡 Note: Automated scanning cannot replace a full security review. ` +
      `This tool checks for common patterns (XSS, injection, exposed secrets, etc.). ` +
      `Manual review and dynamic testing are still necessary.`
    );
  }

  const counts: Record<SecSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity]++;

  const lines: string[] = [
    `🔐 Security Scan — ${language} (${context} context)`,
    `Found ${issues.length} issue(s): 🔴 ${counts.critical} critical  🟠 ${counts.high} high  🟡 ${counts.medium} medium  🔵 ${counts.low} low`,
    ``,
  ];

  for (const issue of issues) {
    lines.push(
      `${SEV_ICON[issue.severity]} Line ${issue.line} — ${issue.category}`,
      `   ${issue.message}`,
      `   Fix: ${issue.remediation}`,
      ``,
    );
  }

  lines.push(
    `💡 Reasoning: Scanned for ${context} security patterns including XSS vectors, ` +
      `injection points, hardcoded secrets, open redirects, and prototype pollution. ` +
      `Address 🔴 critical issues immediately. ` +
      `This static scan complements but does not replace DAST (dynamic testing) and manual code review.`,
  );

  return lines.join("\n");
}
