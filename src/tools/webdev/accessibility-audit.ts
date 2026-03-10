import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AccessibilityAuditSchema = z.object({
  code: z.string().describe("HTML, JSX, or Vue template snippet to audit"),
  wcag_level: z.enum(["A", "AA", "AAA"]).describe("WCAG conformance level to check against"),
  framework: z.enum(["html", "jsx", "vue"]).describe("Code framework/format"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type A11ySeverity = "critical" | "warning" | "info";

export interface A11yIssue {
  line: number;
  severity: A11ySeverity;
  criterion: string;
  message: string;
  fix: string;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface A11yRule {
  id: string;
  criterion: string;
  level: "A" | "AA" | "AAA";
  severity: A11ySeverity;
  pattern: RegExp;
  message: string;
  fix: (match: string) => string;
}

const RULES: A11yRule[] = [
  {
    id: "img-alt",
    criterion: "WCAG 1.1.1 (Non-text Content)",
    level: "A",
    severity: "critical",
    // Matches <img> or JSX <img ... /> without an alt attribute
    pattern: /<img(?![^>]*\balt=)[^>]*>/gi,
    message: "<img> is missing an `alt` attribute",
    fix: (m) => m.replace(/<img/, '<img alt=""'),
  },
  {
    id: "anchor-empty",
    criterion: "WCAG 2.4.4 (Link Purpose)",
    level: "A",
    severity: "critical",
    pattern: /<a\b[^>]*>\s*<\/a>/gi,
    message: "Anchor element has no text content",
    fix: (m) => m.replace(/<\/a>/, "<!-- TODO: add descriptive link text --></a>"),
  },
  {
    id: "button-empty",
    criterion: "WCAG 4.1.2 (Name, Role, Value)",
    level: "A",
    severity: "critical",
    pattern: /<button\b[^>]*>\s*<\/button>/gi,
    message: "Button element has no accessible text",
    fix: (m) => m.replace(/<\/button>/, "<!-- TODO: add button label --></button>"),
  },
  {
    id: "input-no-label",
    criterion: "WCAG 1.3.1 (Info and Relationships)",
    level: "A",
    severity: "critical",
    // Input without aria-label, aria-labelledby, or id (which a <label for=...> would target)
    pattern: /<input\b(?![^>]*(?:aria-label|aria-labelledby|id\s*=))[^>]*>/gi,
    message: "<input> has no associated label (missing aria-label or id for <label for=>)",
    fix: (m) => {
      const withId = m.includes("id=") ? m : m.replace(/<input/, '<input id="field-id"');
      return withId;
    },
  },
  {
    id: "heading-skip",
    criterion: "WCAG 1.3.1 (Info and Relationships)",
    level: "A",
    severity: "warning",
    // Detects <h4>+ without preceding h3 in the same snippet (simplified: warns on h4/h5/h6)
    pattern: /<h[456]\b/gi,
    message: "Heading level h4/h5/h6 found — verify heading hierarchy is not skipped",
    fix: () => "<!-- Ensure h1 → h2 → h3 order is maintained before using this heading level -->",
  },
  {
    id: "tabindex-positive",
    criterion: "WCAG 2.4.3 (Focus Order)",
    level: "A",
    severity: "warning",
    pattern: /tabindex\s*=\s*["'][1-9]\d*["']/gi,
    message: "Positive tabindex disrupts natural focus order",
    fix: (m) => m.replace(/tabindex\s*=\s*["'][^"']*["']/, 'tabindex="0"'),
  },
  {
    id: "onclick-non-interactive",
    criterion: "WCAG 2.1.1 (Keyboard)",
    level: "A",
    severity: "warning",
    // onClick/onclick on non-interactive elements (div, span, p)
    pattern: /<(?:div|span|p)\b[^>]*\bon[Cc]lick\b[^>]*>/g,
    message: "onClick on a non-interactive element — use <button> or add role + keyboard handlers",
    fix: (m) =>
      m
        .replace(/^<(div|span|p)/, '<button')
        .replace(/>$/, ' type="button">'),
  },
  {
    id: "color-only",
    criterion: "WCAG 1.4.1 (Use of Color)",
    level: "A",
    severity: "info",
    pattern: /color:\s*(?:red|green|#[0-9a-f]{3,6})\b/gi,
    message: "Color appears to be used alone — ensure information is not conveyed by color only",
    fix: () => "/* Add text, icon, or pattern as secondary indicator alongside color */",
  },
  {
    id: "link-new-tab-warning",
    criterion: "WCAG 3.2.2 (On Input)",
    level: "A",
    severity: "info",
    pattern: /target\s*=\s*["']_blank["']/gi,
    message: 'Links opening in new tab should warn users (add aria-label or visible indicator)',
    fix: (m) =>
      m.replace(
        /target\s*=\s*["']_blank["']/,
        'target="_blank" rel="noopener noreferrer" aria-label="Opens in new tab"',
      ),
  },
  {
    id: "form-no-submit",
    criterion: "WCAG 2.1.1 (Keyboard)",
    level: "A",
    severity: "warning",
    // <form> without an onSubmit handler or submit button
    pattern: /<form\b(?![^>]*(?:onSubmit|action))[^>]*>/gi,
    message: "<form> has no onSubmit/action — keyboard users cannot submit",
    fix: (m) => m.replace(/<form/, '<form onSubmit={handleSubmit}'),
  },
  {
    id: "svg-no-title",
    criterion: "WCAG 1.1.1 (Non-text Content)",
    level: "A",
    severity: "warning",
    // <svg> without aria-label, aria-hidden, or <title>
    pattern: /<svg\b(?![^>]*(?:aria-label|aria-hidden))[^>]*>/gi,
    message: "<svg> is missing aria-label or aria-hidden (decorative SVGs need aria-hidden=\"true\")",
    fix: (m) => m.replace(/<svg/, '<svg aria-hidden="true"'),
  },
  // AA-level rules
  {
    id: "contrast-inline-style",
    criterion: "WCAG 1.4.3 (Contrast Minimum)",
    level: "AA",
    severity: "warning",
    pattern: /color:\s*#(?:ccc|ddd|eee|aaa|bbb|999|888|fff|ffffff|eeeeee|dddddd|cccccc)\b/gi,
    message: "Low-contrast color detected in inline style — verify 4.5:1 ratio for normal text",
    fix: () => "/* Use a color with sufficient contrast ratio (≥4.5:1 for normal text) */",
  },
  {
    id: "small-touch-target",
    criterion: "WCAG 2.5.8 (Target Size)",
    level: "AA",
    severity: "info",
    // Very small explicit width/height on interactive elements
    pattern: /(?:width|height)\s*:\s*(?:[0-9]|1[0-9]|2[0-3])px/gi,
    message: "Touch target may be too small — WCAG 2.5.8 recommends at least 24×24px",
    fix: () => "/* Set min-width/min-height: 44px for touch targets (WCAG 2.5.5 enhanced) */",
  },
];

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

function auditCode(
  code: string,
  wcagLevel: "A" | "AA" | "AAA",
  _framework: string,
): A11yIssue[] {
  const lines = code.split("\n");
  const issues: A11yIssue[] = [];

  // Level hierarchy: AAA includes AA includes A
  const includedLevels =
    wcagLevel === "A" ? ["A"] : wcagLevel === "AA" ? ["A", "AA"] : ["A", "AA", "AAA"];

  for (const rule of RULES) {
    if (!includedLevels.includes(rule.level)) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let match: RegExpExecArray | null;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "") + "g");
      while ((match = re.exec(line)) !== null) {
        issues.push({
          line: i + 1,
          severity: rule.severity,
          criterion: rule.criterion,
          message: rule.message,
          fix: rule.fix(match[0]),
        });
        // Prevent infinite loops on zero-length matches
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  // Sort: critical first, then by line
  const order: Record<A11ySeverity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);

  return issues;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const SEV_ICON: Record<A11ySeverity, string> = {
  critical: "🔴",
  warning: "🟠",
  info: "🔵",
};

function formatIssues(issues: A11yIssue[], wcagLevel: string): string {
  if (issues.length === 0) {
    return `✅ No accessibility issues found at WCAG ${wcagLevel} level.`;
  }

  const critical = issues.filter((i) => i.severity === "critical").length;
  const warning = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;

  const lines: string[] = [
    `🔍 Accessibility Audit — WCAG ${wcagLevel}`,
    `Found ${issues.length} issue(s): 🔴 ${critical} critical  🟠 ${warning} warning  🔵 ${info} info`,
    ``,
  ];

  for (const issue of issues) {
    lines.push(
      `${SEV_ICON[issue.severity]} Line ${issue.line} — ${issue.criterion}`,
      `   ${issue.message}`,
      `   Fix: ${issue.fix}`,
      ``,
    );
  }

  lines.push(
    `💡 Reasoning: Scanned for WCAG ${wcagLevel} violations including missing alt text, ` +
      `unlabeled form controls, empty interactive elements, keyboard accessibility issues, ` +
      `and color contrast concerns. Automated checks cannot replace manual testing with ` +
      `a screen reader (NVDA, JAWS, VoiceOver).`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleAccessibilityAudit({ code: '<img src="hero.jpg">', wcag_level: "AA", framework: "html" })

export function handleAccessibilityAudit(
  args: z.infer<typeof AccessibilityAuditSchema>,
): string {
  const { code, wcag_level, framework } = args;
  const issues = auditCode(code, wcag_level, framework);
  return formatIssues(issues, wcag_level);
}
