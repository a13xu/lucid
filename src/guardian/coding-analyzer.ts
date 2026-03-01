import { extname } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QualitySeverity = "high" | "medium" | "low";

export interface QualityIssue {
  file: string;
  line: number;
  severity: QualitySeverity;
  ruleId: string;
  message: string;
  suggestion: string;
}

const SEVERITY_ORDER: Record<QualitySeverity, number> = {
  high: 0, medium: 1, low: 2,
};

const SEVERITY_ICON: Record<QualitySeverity, string> = {
  high: "🔴", medium: "🟠", low: "🔵",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFrontend(filepath: string, lang?: string): boolean {
  if (lang === "vue") return true;
  const ext = extname(filepath).toLowerCase();
  return ext === ".tsx" || ext === ".jsx" || ext === ".vue";
}

/** Returns true if the line looks like a function definition with an opening brace. */
function isFuncDefLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) return false;
  // Exclude control-flow keywords
  if (/^\s*(?:if|for|while|switch|try|catch|else)\b/.test(line)) return false;
  return (
    /\bfunction\b/.test(line) ||
    /=>\s*\{/.test(line) ||
    /\)\s*(?::\s*[\w<>[\]|\s,&]+)?\s*\{/.test(line)
  ) && line.includes("{");
}

/** Extract function name from a definition line, or null. */
function extractFuncName(line: string): string | null {
  // function foo(
  let m = line.match(/\bfunction\s+(\w+)\s*\(/);
  if (m) return m[1] ?? null;
  // const/let/var foo =
  m = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
  if (m) return m[1] ?? null;
  // method foo(: TypeScript class method
  m = line.match(/^\s*(?:async\s+)?(\w+)\s*\(/);
  if (m && !["if", "for", "while", "switch", "try", "catch", "else", "return"].includes(m[1]!)) {
    return m[1] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// General quality rules (all languages)
// ---------------------------------------------------------------------------

function analyzeGeneral(filepath: string, lines: string[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const totalLines = lines.length;

  // GR001-FILE-SIZE
  if (totalLines > 500) {
    issues.push({
      file: filepath, line: 1, severity: "high", ruleId: "GR001-FILE-SIZE",
      message: `File is ${totalLines} lines (max: 500)`,
      suggestion: "Split into smaller modules or extract helpers.",
    });
  }

  // GR002-FUNC-LENGTH: brace-counting, max 400-line scan
  {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isFuncDefLine(line)) {
        let depth = 0;
        let end = i;
        let found = false;
        for (let j = i; j < Math.min(i + 400, lines.length); j++) {
          for (const ch of lines[j]!) {
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
          }
          if (depth === 0 && j > i) {
            const funcLen = j - i;
            if (funcLen > 60) {
              const name = extractFuncName(line);
              const label = name ? `"${name}"` : "Anonymous function";
              issues.push({
                file: filepath, line: i + 1,
                severity: funcLen > 100 ? "high" : "medium",
                ruleId: "GR002-FUNC-LENGTH",
                message: `${label} is ${funcLen} lines (max: 60)`,
                suggestion: "Break into smaller functions. Each function should do ONE thing.",
              });
            }
            end = j;
            found = true;
            break;
          }
        }
        i = found ? end + 1 : i + 1;
      } else {
        i++;
      }
    }
  }

  // GR003 — naming issues (single pass over all lines)
  const BAD_VAR_NAMES = /\b(?:const|let|var)\s+(x|y|z|tmp|temp|data2|result2|val|obj|foo|bar)\s*=/;
  const VAGUE_FUNC_NAMES = /\b(handleStuff|doSomething|processData|doWork|manage)\b/;
  const AND_OR_IN_NAME = /\b\w*(?:And|Or)\w+\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const num = i + 1;

    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;

    // GR003-BAD-VAR
    const badVarMatch = line.match(BAD_VAR_NAMES);
    if (badVarMatch) {
      issues.push({
        file: filepath, line: num, severity: "medium", ruleId: "GR003-BAD-VAR",
        message: `Vague variable name "${badVarMatch[1]}"`,
        suggestion: "Use descriptive names that explain purpose, not shape.",
      });
    }

    // GR003-VAGUE-FUNC (on definition lines only)
    if (isFuncDefLine(line)) {
      const vagueMatch = line.match(VAGUE_FUNC_NAMES);
      if (vagueMatch) {
        issues.push({
          file: filepath, line: num, severity: "medium", ruleId: "GR003-VAGUE-FUNC",
          message: `Vague function name "${vagueMatch[1]}"`,
          suggestion: "Name functions after their specific action and object (e.g. parseUserResponse).",
        });
      }

      // GR003-AND-NAME
      const funcName = extractFuncName(line);
      if (funcName && AND_OR_IN_NAME.test(funcName)) {
        issues.push({
          file: filepath, line: num, severity: "low", ruleId: "GR003-AND-NAME",
          message: `Function "${funcName}" suggests multiple responsibilities`,
          suggestion: "Split into two functions, one per responsibility.",
        });
      }
    }

    // GR004-DEEP-NEST: ≥16 leading spaces or ≥4 tabs
    if (trimmed.length > 0) {
      const leadingSpaces = line.match(/^( +)/)?.[1]?.length ?? 0;
      const leadingTabs = line.match(/^(\t+)/)?.[1]?.length ?? 0;
      if (leadingSpaces >= 16 || leadingTabs >= 4) {
        issues.push({
          file: filepath, line: num, severity: "medium", ruleId: "GR004-DEEP-NEST",
          message: "Code nested 4+ levels deep",
          suggestion: "Extract nested logic into helper functions or use early returns.",
        });
      }
    }
  }

  // GR005-DEAD-CODE: 3+ consecutive commented lines containing code-like tokens
  {
    let blockStart = 0;
    let blockLen = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      const isCommentedCode =
        (trimmed.startsWith("//") || trimmed.startsWith("#")) &&
        /[=({;]/.test(trimmed);
      if (isCommentedCode) {
        if (blockLen === 0) blockStart = i + 1;
        blockLen++;
        if (blockLen === 3) {
          issues.push({
            file: filepath, line: blockStart, severity: "low", ruleId: "GR005-DEAD-CODE",
            message: "3+ consecutive commented-out code lines",
            suggestion: "Remove dead code. Use version control (git) to track history.",
          });
        }
      } else {
        blockLen = 0;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Frontend rules (.tsx, .jsx, .vue)
// ---------------------------------------------------------------------------

function analyzeFrontend(filepath: string, lines: string[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const totalLines = lines.length;

  // FE001-COMP-SIZE
  if (totalLines > 300) {
    issues.push({
      file: filepath, line: 1, severity: "high", ruleId: "FE001-COMP-SIZE",
      message: `Component is ${totalLines} lines (max: 300)`,
      suggestion: "Extract sub-components or custom hooks.",
    });
  }

  // FE002-PROP-COUNT: component destructures > 8 props
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/(?:function\s+[A-Z]|const\s+[A-Z])\w*.*\(\s*\{/.test(line)) continue;

    // Collect lines until the destructuring block closes
    let collected = line;
    let j = i;
    let opens = (collected.match(/\{/g) ?? []).length;
    let closes = (collected.match(/\}/g) ?? []).length;
    while (opens > closes && j < lines.length - 1) {
      j++;
      const next = lines[j]!;
      collected += " " + next;
      opens += (next.match(/\{/g) ?? []).length;
      closes += (next.match(/\}/g) ?? []).length;
    }

    // Extract content between ({ and first })
    const propBlock = collected.match(/\(\s*\{([^}]*)\}/);
    if (propBlock) {
      const props = propBlock[1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("//"));
      if (props.length > 8) {
        issues.push({
          file: filepath, line: i + 1, severity: "medium", ruleId: "FE002-PROP-COUNT",
          message: `Component destructures ${props.length} props`,
          suggestion: "Group related props into objects. Apply Rule #14: Prefer composition.",
        });
      }
    }
  }

  // FE003-BOOL-PROPS: 3+ is/has/can/should-prefixed boolean props in a Props interface/type
  {
    let inProps = false;
    let depth = 0;
    let boolCount = 0;
    let propsStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (!inProps && /(?:type|interface)\s+\w*Props\s*(?:=\s*\{|\{)/.test(line)) {
        inProps = true;
        depth = 0;
        boolCount = 0;
        propsStartLine = i + 1;
      }

      if (inProps) {
        for (const ch of line) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }

        if (/^\s*(is|has|can|should)[A-Z]\w*[?:].*boolean/.test(line)) {
          boolCount++;
        }

        if (depth <= 0 && i > propsStartLine - 1) {
          if (boolCount >= 3) {
            issues.push({
              file: filepath, line: propsStartLine, severity: "medium", ruleId: "FE003-BOOL-PROPS",
              message: `${boolCount} boolean props found (is/has/can/should prefix)`,
              suggestion: "Replace with a single `status` prop or `variant` enum.",
            });
          }
          inProps = false;
        }
      }
    }
  }

  // FE004-INLINE-STYLE: style={{ in JSX or Vue template
  for (let i = 0; i < lines.length; i++) {
    if (/style=\{\{/.test(lines[i]!)) {
      issues.push({
        file: filepath, line: i + 1, severity: "medium", ruleId: "FE004-INLINE-STYLE",
        message: "Inline style object in JSX/Vue template",
        suggestion: "Move to a CSS/SCSS module, styled-components, or Tailwind class.",
      });
    }
  }

  // FE005-FETCH-IN-COMP: fetch/axios at component body depth 1 (not inside hook/effect)
  {
    let inComponent = false;
    let compBraceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (!inComponent && /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=)/.test(line)) {
        inComponent = true;
        compBraceDepth = 0;
      }

      if (inComponent) {
        for (const ch of line) {
          if (ch === "{") compBraceDepth++;
          else if (ch === "}") compBraceDepth--;
        }

        // depth 1 = top-level body of the component function (not inside a hook/callback)
        if (compBraceDepth === 1 && /(?:fetch\s*\(|axios\.)/.test(line)) {
          issues.push({
            file: filepath, line: i + 1, severity: "high", ruleId: "FE005-FETCH-IN-COMP",
            message: "fetch() or axios called directly in component body",
            suggestion: "Move to a custom hook (e.g. useUserData) or a service layer.",
          });
        }

        if (compBraceDepth <= 0) {
          inComponent = false;
          compBraceDepth = 0;
        }
      }
    }
  }

  // FE006-DIRECT-DOM: document.querySelector / getElementById in component file
  for (let i = 0; i < lines.length; i++) {
    if (/document\.querySelector|document\.getElementById/.test(lines[i]!)) {
      issues.push({
        file: filepath, line: i + 1, severity: "high", ruleId: "FE006-DIRECT-DOM",
        message: "Direct DOM access in component file",
        suggestion: "Use refs (useRef in React, ref= in Vue) instead of direct DOM queries.",
      });
    }
  }

  // FE007-MIXED-STYLE: Tailwind + styled-components + CSS module all in same file
  {
    const hasTailwind = lines.some((l) => /className=["'][^"']*(?:flex|grid|text-|bg-|p-\d|m-\d)/.test(l));
    const hasStyled = lines.some((l) => /import.*from\s+['"]styled-components['"]/.test(l));
    const hasCssModule = lines.some((l) => /import.*from\s+['"].*\.module\.css['"]/.test(l));
    if (hasTailwind && hasStyled && hasCssModule) {
      issues.push({
        file: filepath, line: 1, severity: "low", ruleId: "FE007-MIXED-STYLE",
        message: "Three styling systems in one file (Tailwind + styled-components + CSS module)",
        suggestion: "Choose one styling approach per project and be consistent.",
      });
    }
  }

  // FE008-JSX-TERNARY: nested ternary on a JSX-bearing line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // JSX line: contains < followed by uppercase letter or /
    if (!/<[A-Z/]/.test(line) && !/<\//.test(line)) continue;
    // Nested ternary: two ? ... : patterns on the same line
    if (/\?[^?:]+:[^?:]*\?/.test(line)) {
      issues.push({
        file: filepath, line: i + 1, severity: "medium", ruleId: "FE008-JSX-TERNARY",
        message: "Nested ternary expression in JSX",
        suggestion: "Extract condition to a variable or sub-component for readability.",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeCodeQuality(filepath: string, source: string, lang?: string): QualityIssue[] {
  const lines = source.split("\n");
  const issues: QualityIssue[] = [
    ...analyzeGeneral(filepath, lines),
    ...(isFrontend(filepath, lang) ? analyzeFrontend(filepath, lines) : []),
  ];

  issues.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity]! - SEVERITY_ORDER[b.severity]!;
    return sevDiff !== 0 ? sevDiff : a.line - b.line;
  });

  return issues;
}

export function formatQualityReport(filepath: string, issues: QualityIssue[]): string {
  const out: string[] = [
    "=".repeat(60),
    "🏛️  CODE QUALITY GUARD — Report",
    "=".repeat(60),
    `File: ${filepath}`,
    `Issues: ${issues.length}`,
    "",
  ];

  if (issues.length === 0) {
    out.push("✅ All quality checks passed.");
    out.push("   Review the full checklist with the coding_rules tool before marking done.");
  } else {
    for (const sev of ["high", "medium", "low"] as QualitySeverity[]) {
      const group = issues.filter((i) => i.severity === sev);
      if (group.length === 0) continue;
      out.push(`--- ${sev.toUpperCase()} (${group.length}) ---`);
      for (const issue of group) {
        out.push(`${SEVERITY_ICON[sev]} [${issue.ruleId}] line ${issue.line} — ${issue.message}`);
        out.push(`   💡 ${issue.suggestion}`);
      }
      out.push("");
    }

    const hasHigh = issues.some((i) => i.severity === "high");
    out.push(
      hasHigh
        ? "❌ FAIL — Fix high-severity issues before proceeding."
        : "⚠️  WARN — Medium/low issues found. Review before marking done.",
    );
  }

  out.push("=".repeat(60));
  return out.join("\n");
}
