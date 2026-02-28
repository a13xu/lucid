import { readFileSync } from "fs";
import { extname } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Issue {
  file: string;
  line: number;
  severity: Severity;
  driftId: string;
  message: string;
  suggestion?: string;
  snippet?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

const SEVERITY_ICON: Record<Severity, string> = {
  critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "ℹ️",
};

export function formatIssue(issue: Issue): string {
  const icon = SEVERITY_ICON[issue.severity];
  let s = `${icon} [${issue.driftId}] ${issue.file}:${issue.line} — ${issue.message}`;
  if (issue.suggestion) s += `\n   💡 ${issue.suggestion}`;
  if (issue.snippet) s += `\n   📄 ${issue.snippet.trim().slice(0, 80)}`;
  return s;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".rs": "rust",
  ".go": "go",
};

export function detectLanguage(filepath: string): string {
  return LANG_MAP[extname(filepath).toLowerCase()] ?? "generic";
}

// ---------------------------------------------------------------------------
// Python analyzer (regex-based port of AST checks)
// ---------------------------------------------------------------------------

function analyzePython(filepath: string, lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const num = i + 1;
    const trimmed = line.trim();

    // Mutable default argument: def f(x=[], def f(x={})
    if (/def\s+\w+\s*\(/.test(trimmed) && /=\s*[\[\{]/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "high",
        driftId: "PY-MUT-DEFAULT",
        message: "Mutable default argument in function definition",
        suggestion: "Use None as default and create inside function body.",
        snippet: trimmed,
      });
    }

    // Bare except:
    if (/^\s*except\s*:/.test(line)) {
      issues.push({
        file: filepath, line: num, severity: "high",
        driftId: "PY-BARE-EXCEPT",
        message: "Bare `except:` catches everything including KeyboardInterrupt",
        suggestion: "Use `except Exception:` or catch specific exceptions.",
      });
    }

    // Silent except (except followed by pass on next line)
    if (/^\s*except[\s:]/.test(line) && i + 1 < lines.length) {
      const next = lines[i + 1]!.trim();
      if (next === "pass") {
        issues.push({
          file: filepath, line: num, severity: "critical",
          driftId: "DRIFT-002",
          message: "Exception silently swallowed with `pass`",
          suggestion: "Log the error, re-raise, or handle explicitly.",
        });
      }
    }

    // == None instead of is None
    if (/==\s*None/.test(trimmed) && !trimmed.startsWith("#")) {
      issues.push({
        file: filepath, line: num, severity: "medium",
        driftId: "PY-IS-NONE",
        message: "Using `== None` instead of `is None`",
        suggestion: "Use `is None` for None checks (PEP 8).",
        snippet: trimmed,
      });
    }

    // != None instead of is not None
    if (/!=\s*None/.test(trimmed) && !trimmed.startsWith("#")) {
      issues.push({
        file: filepath, line: num, severity: "medium",
        driftId: "PY-IS-NONE",
        message: "Using `!= None` instead of `is not None`",
        suggestion: "Use `is not None` for None checks (PEP 8).",
        snippet: trimmed,
      });
    }

    // f-string without interpolation
    if (/f['"][^{'"]*['"]/.test(trimmed) && !trimmed.includes("{")) {
      issues.push({
        file: filepath, line: num, severity: "low",
        driftId: "PY-FSTRING-EMPTY",
        message: "f-string without any interpolation",
        suggestion: "Remove the `f` prefix or add variables.",
        snippet: trimmed,
      });
    }

    // async def without await in body (heuristic: next non-empty line doesn't await)
    if (/^\s*async\s+def\s+/.test(line)) {
      // Collect the function body (next ~20 lines) and check for await
      const body = lines.slice(i + 1, i + 20).join("\n");
      if (!body.includes("await ") && !body.includes("async for") && !body.includes("async with")) {
        issues.push({
          file: filepath, line: num, severity: "medium",
          driftId: "DRIFT-003",
          message: "async function may not use await — could be incorrectly async",
          suggestion: "Verify this function actually needs to be async.",
          snippet: trimmed,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript analyzer
// ---------------------------------------------------------------------------

function analyzeJavaScript(filepath: string, lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const num = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // == instead of === (but not !== or ===)
    if (/[^!=><]={2}[^=]/.test(trimmed) && !/={3}/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "medium",
        driftId: "JS-STRICT-EQ",
        message: "Using `==` instead of `===`",
        suggestion: "Use strict equality `===` unless coercion is intentional.",
        snippet: trimmed,
      });
    }

    // console.log left in
    if (/console\.log\s*\(/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "low",
        driftId: "JS-CONSOLE",
        message: "console.log() left in code",
        suggestion: "Remove or replace with proper logging.",
        snippet: trimmed,
      });
    }

    // .then() without .catch() on same line
    if (/\.then\s*\(/.test(trimmed) && !/\.catch\s*\(/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "medium",
        driftId: "JS-UNCAUGHT-PROMISE",
        message: "`.then()` without `.catch()` — unhandled promise rejection",
        suggestion: "Add `.catch()` or use try/catch with async/await.",
        snippet: trimmed,
      });
    }

    // .sort() without comparator
    if (/\.sort\s*\(\s*\)/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "high",
        driftId: "JS-SORT-DEFAULT",
        message: "`.sort()` without comparator sorts as strings",
        suggestion: "Use `.sort((a, b) => a - b)` for numeric sort.",
        snippet: trimmed,
      });
    }

    // any type in TypeScript
    if (/:\s*any\b/.test(trimmed) || /as\s+any\b/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "low",
        driftId: "TS-ANY",
        message: "`any` type leaking through — disables type safety",
        suggestion: "Use a specific type or `unknown` with type narrowing.",
        snippet: trimmed,
      });
    }

    // non-null assertion masking bugs
    if (/\w!\.\w/.test(trimmed) || /\w!\[/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "medium",
        driftId: "TS-NON-NULL",
        message: "Non-null assertion `!` — could crash if value is actually null",
        suggestion: "Add explicit null check instead.",
        snippet: trimmed,
      });
    }

    // Early return with potential wrong value (heuristic)
    if (/return\s+true\b/.test(trimmed) || /return\s+false\b/.test(trimmed)) {
      issues.push({
        file: filepath, line: num, severity: "info",
        driftId: "DRIFT-005",
        message: "Boolean return — verify this is the correct value for this branch",
        suggestion: "Logic inversions are the #1 LLM drift pattern. Double-check.",
        snippet: trimmed,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Generic analyzer (language-agnostic)
// ---------------------------------------------------------------------------

function analyzeGeneric(filepath: string, lines: string[]): Issue[] {
  const issues: Issue[] = [];

  // TODO / FIXME / HACK markers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const num = i + 1;
    for (const marker of ["TODO", "FIXME", "HACK", "XXX", "BUG"]) {
      if (line.toUpperCase().includes(marker) && /[/#*\-]/.test(line)) {
        issues.push({
          file: filepath, line: num, severity: "info",
          driftId: "MARKER",
          message: `${marker} marker found`,
          snippet: line.trim(),
        });
      }
    }
  }

  // Near-duplicate blocks (copy-paste drift detection)
  const BLOCK_SIZE = 5;
  const seen = new Map<string, number>();

  for (let i = 0; i <= lines.length - BLOCK_SIZE; i++) {
    const block = lines.slice(i, i + BLOCK_SIZE).map((l) => l.trim()).filter(Boolean);
    if (block.length < 3) continue;

    // Normalize: replace identifiers with placeholder
    const sig = block.map((l) => l.replace(/\b[a-z_]\w*\b/g, "_")).join("|");

    const prev = seen.get(sig);
    if (prev !== undefined && i - prev > BLOCK_SIZE) {
      issues.push({
        file: filepath, line: i + 1, severity: "medium",
        driftId: "DRIFT-007",
        message: `Near-duplicate block (similar to line ${prev + 1})`,
        suggestion: "Verify all variable names were updated correctly in the copy.",
      });
    } else {
      seen.set(sig, i);
    }
  }

  // Magic numbers (2+ digit numbers not in common whitelist)
  const MAGIC_WHITELIST = new Set([10, 16, 32, 64, 100, 128, 256, 512, 1000, 1024, 2048, 4096, 8080, 3000, 8000]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^[/#*\-]/.test(trimmed)) continue;
    for (const match of trimmed.matchAll(/(?<![.\w])(\d{2,})(?![.\w])/g)) {
      const num = parseInt(match[1]!, 10);
      if (!MAGIC_WHITELIST.has(num) && !/port|size|limit|max|min/i.test(trimmed)) {
        issues.push({
          file: filepath, line: i + 1, severity: "low",
          driftId: "MAGIC-NUM",
          message: `Magic number \`${num}\` — consider a named constant`,
          snippet: trimmed,
        });
        break; // one per line is enough
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidationResult {
  issues: Issue[];
  filesChecked: number;
  linesChecked: number;
  passed: boolean;
}

export function validateSource(filepath: string, source: string, lang?: string): Issue[] {
  const language = lang ?? detectLanguage(filepath);
  const lines = source.split("\n");
  const issues: Issue[] = [];

  if (language === "python") {
    issues.push(...analyzePython(filepath, lines));
  } else if (language === "javascript" || language === "typescript") {
    issues.push(...analyzeJavaScript(filepath, lines));
  }

  issues.push(...analyzeGeneric(filepath, lines));

  issues.sort((a, b) => SEVERITY_ORDER[a.severity]! - SEVERITY_ORDER[b.severity]!);
  return issues;
}

export function validateFile(filepath: string): Issue[] {
  let source: string;
  try {
    source = readFileSync(filepath, { encoding: "utf-8" });
  } catch (err) {
    return [{
      file: filepath, line: 0, severity: "critical",
      driftId: "IO-ERROR",
      message: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    }];
  }
  return validateSource(filepath, source);
}

export function formatReport(filepath: string, issues: Issue[]): string {
  const lines: string[] = [
    "=".repeat(60),
    "🛡️  LOGIC GUARDIAN — Validation Report",
    "=".repeat(60),
    `File: ${filepath}`,
    `Issues: ${issues.length}`,
    "",
  ];

  if (issues.length === 0) {
    lines.push("✅ No issues detected. Proceed with confidence.");
    lines.push("");
    lines.push("⚠️  Automated checks catch ~40% of drift patterns.");
    lines.push("   The manual checklist (Passes 1-5) catches the rest.");
  } else {
    const bySeverity = (s: Severity) => issues.filter((i) => i.severity === s);
    for (const sev of ["critical", "high", "medium", "low", "info"] as Severity[]) {
      const group = bySeverity(sev);
      if (group.length > 0) {
        lines.push(`--- ${sev.toUpperCase()} (${group.length}) ---`);
        for (const issue of group) lines.push(formatIssue(issue));
        lines.push("");
      }
    }

    const criticalCount = bySeverity("critical").length;
    const highCount = bySeverity("high").length;
    const passed = criticalCount === 0 && highCount === 0;
    lines.push(passed
      ? "✅ PASS — No critical or high severity issues."
      : "❌ FAIL — Fix critical/high issues before proceeding."
    );
  }

  lines.push("=".repeat(60));
  return lines.join("\n");
}
