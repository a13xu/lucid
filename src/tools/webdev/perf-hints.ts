import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PerfHintsSchema = z.object({
  code: z.string().describe("Component or page source code to analyze"),
  framework: z
    .enum(["react", "vue", "nuxt", "vanilla"])
    .describe("Frontend framework"),
  context: z
    .enum(["component", "page", "layout"])
    .describe("File role in the application"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CwvMetric = "LCP" | "CLS" | "INP" | "FCP" | "TTFB" | "General";
export type PerfImpact = "high" | "medium" | "low";

export interface PerfIssue {
  line: number;
  metric: CwvMetric;
  impact: PerfImpact;
  message: string;
  fix: string;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface PerfRule {
  id: string;
  metric: CwvMetric;
  impact: PerfImpact;
  frameworks: Array<"react" | "vue" | "nuxt" | "vanilla" | "all">;
  contexts: Array<"component" | "page" | "layout" | "all">;
  pattern: RegExp;
  message: string;
  fix: string;
}

const RULES: PerfRule[] = [
  // LCP rules
  {
    id: "lcp-no-priority-img",
    metric: "LCP",
    impact: "high",
    frameworks: ["react", "all"],
    contexts: ["page", "layout"],
    // Next.js Image without priority on hero images
    pattern: /<Image\b(?![^>]*\bpriority\b)[^>]*(?:hero|banner|above-fold|lcp)[^>]*>/gi,
    message: "Hero/LCP Image missing `priority` prop — delays LCP",
    fix: "Add priority to the above-the-fold <Image> component: <Image priority ... />",
  },
  {
    id: "lcp-img-no-dimensions",
    metric: "LCP",
    impact: "high",
    frameworks: ["all"],
    contexts: ["all"],
    // <img> without width and height attributes
    pattern: /<img\b(?![^>]*\bwidth\b)[^>]*>/gi,
    message: "<img> missing width/height — browser cannot reserve layout space, causing reflow",
    fix: "Always add explicit width and height to <img> to prevent layout shifts and help LCP",
  },
  {
    id: "lcp-large-background",
    metric: "LCP",
    impact: "medium",
    frameworks: ["all"],
    contexts: ["page", "layout"],
    pattern: /background-image\s*:\s*url\s*\(/gi,
    message: "CSS background-image is not preloadable — consider using <img> for LCP element",
    fix: "Use <img> instead of background-image for above-the-fold hero images so browsers can preload them",
  },
  // CLS rules
  {
    id: "cls-no-aspect-ratio",
    metric: "CLS",
    impact: "high",
    frameworks: ["all"],
    contexts: ["all"],
    // img/video without aspect-ratio or explicit dimensions
    pattern: /<(?:img|video|iframe)\b(?![^>]*(?:width|aspect-ratio))[^>]*>/gi,
    message: "Media element without dimensions/aspect-ratio causes layout shift (CLS)",
    fix: "Add width + height attrs or aspect-ratio CSS to reserve space before media loads",
  },
  {
    id: "cls-dynamic-inject",
    metric: "CLS",
    impact: "high",
    frameworks: ["all"],
    contexts: ["page", "layout"],
    // Ad slots, banners injected dynamically
    pattern: /document\.body\.(?:append|prepend|insertBefore)|\.insertAdjacentElement\s*\(\s*["'](?:beforebegin|afterbegin)/g,
    message: "Dynamic DOM insertion at top of page causes CLS",
    fix: "Reserve space for dynamically injected content (ads, banners) with a min-height placeholder",
  },
  {
    id: "cls-font-swap",
    metric: "CLS",
    impact: "medium",
    frameworks: ["all"],
    contexts: ["page", "layout"],
    pattern: /@font-face\b(?![^}]*font-display)/gi,
    message: "@font-face without font-display can cause text layout shift (FOUT/FOIT)",
    fix: "Add font-display: swap (or optional) to @font-face rules",
  },
  // INP rules
  {
    id: "inp-heavy-click-handler",
    metric: "INP",
    impact: "high",
    frameworks: ["react", "vue", "all"],
    contexts: ["component", "all"],
    // Synchronous loops or complex operations in event handlers
    pattern: /(?:onClick|@click|v-on:click)\s*=\s*\{[^}]*(?:for\s*\(|while\s*\(|\.forEach\s*\()/g,
    message: "Potentially heavy computation in click handler — can block main thread and hurt INP",
    fix: "Move expensive work off click handler: use setTimeout, requestIdleCallback, or Web Worker",
  },
  {
    id: "inp-missing-memo",
    metric: "INP",
    impact: "medium",
    frameworks: ["react"],
    contexts: ["component"],
    // Large lists without useMemo/memo
    pattern: /\.map\s*\(\s*\([^)]*\)\s*=>/g,
    message: "Array .map() in render — if list is large, wrap with useMemo to avoid re-renders",
    fix: "const items = useMemo(() => data.map(...), [data]); — prevents recalculation on unrelated renders",
  },
  {
    id: "inp-missing-computed",
    metric: "INP",
    impact: "medium",
    frameworks: ["vue", "nuxt"],
    contexts: ["component"],
    // .filter/.reduce in template expressions
    pattern: /\{\{[^}]*\.(?:filter|reduce|sort|map)\s*\(/g,
    message: "Array transform in template expression runs on every render — use computed()",
    fix: "Move .filter()/.map()/.sort() to a computed property: const filtered = computed(() => items.value.filter(...))",
  },
  // FCP / TTFB rules
  {
    id: "ttfb-fetch-in-render",
    metric: "TTFB",
    impact: "high",
    frameworks: ["react", "vue", "nuxt", "vanilla"],
    contexts: ["component", "page"],
    // fetch() or axios() called directly in component body (not in useEffect/onMounted/setup)
    pattern: /(?:^|\n)\s*(?:const|let)\s+\w+\s*=\s*(?:await\s+)?(?:fetch|axios)\s*\(/gm,
    message: "Data fetching at component root level — can block rendering and inflate TTFB",
    fix: "Move data fetching into useEffect (React), onMounted/setup (Vue), or use SSR data fetching (useFetch in Nuxt, getServerSideProps in Next)",
  },
  {
    id: "fcp-render-blocking",
    metric: "FCP",
    impact: "high",
    frameworks: ["all"],
    contexts: ["page", "layout"],
    // Synchronous scripts in <head>
    pattern: /<script\b(?![^>]*(?:async|defer|type\s*=\s*["']module["']))[^>]*src=/gi,
    message: "Render-blocking synchronous <script> in document — delays FCP",
    fix: "Add defer or async attribute: <script defer src=...> or <script type=\"module\" src=...>",
  },
  // General perf rules
  {
    id: "general-console-log",
    metric: "General",
    impact: "low",
    frameworks: ["all"],
    contexts: ["all"],
    pattern: /console\.log\s*\(/g,
    message: "console.log() left in production code — minor serialization overhead",
    fix: "Remove console.log calls or guard with: if (process.env.NODE_ENV !== 'production') console.log(...)",
  },
  {
    id: "general-inline-style-object",
    metric: "CLS",
    impact: "low",
    frameworks: ["react"],
    contexts: ["component"],
    // Recreated style objects on every render
    pattern: /style\s*=\s*\{\s*\{/g,
    message: "Inline style object recreated on every render — extract to constant or use className",
    fix: "Move to a const outside the component: const styles = { ... }; or use a CSS class",
  },
  {
    id: "general-large-import",
    metric: "FCP",
    impact: "medium",
    frameworks: ["all"],
    contexts: ["all"],
    // Import of whole large libraries
    pattern: /import\s+\*\s+as\s+\w+\s+from\s+["'](?:lodash|moment|rxjs)["']/g,
    message: "Whole library import (lodash/moment/rxjs) increases bundle size — tree-shake",
    fix: "Import only what you need: import { debounce } from 'lodash-es' or import debounce from 'lodash/debounce'",
  },
];

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

function analyzePerf(
  code: string,
  framework: "react" | "vue" | "nuxt" | "vanilla",
  context: "component" | "page" | "layout",
): PerfIssue[] {
  const lines = code.split("\n");
  const issues: PerfIssue[] = [];

  for (const rule of RULES) {
    const fw = rule.frameworks;
    if (!fw.includes("all") && !fw.includes(framework)) continue;
    const ctx = rule.contexts;
    if (!ctx.includes("all") && !ctx.includes(context)) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*\/\/|^\s*\*/.test(line)) continue;

      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "") + "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        issues.push({
          line: i + 1,
          metric: rule.metric,
          impact: rule.impact,
          message: rule.message,
          fix: rule.fix,
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  const metricOrder: Record<CwvMetric, number> = { LCP: 0, CLS: 1, INP: 2, FCP: 3, TTFB: 4, General: 5 };
  const impactOrder: Record<PerfImpact, number> = { high: 0, medium: 1, low: 2 };
  issues.sort(
    (a, b) =>
      metricOrder[a.metric] - metricOrder[b.metric] ||
      impactOrder[a.impact] - impactOrder[b.impact] ||
      a.line - b.line,
  );

  return issues;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const IMPACT_ICON: Record<PerfImpact, string> = { high: "🔴", medium: "🟠", low: "🔵" };
const METRIC_EMOJI: Record<CwvMetric, string> = {
  LCP: "🖼️", CLS: "📐", INP: "⚡", FCP: "🎨", TTFB: "🌐", General: "⚙️",
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handlePerfHints({ code: '<img src="hero.jpg">', framework: "react", context: "page" })

export function handlePerfHints(args: z.infer<typeof PerfHintsSchema>): string {
  const { code, framework, context } = args;
  const issues = analyzePerf(code, framework, context);

  if (issues.length === 0) {
    return (
      `✅ No performance issues detected (${framework}, ${context} context).\n\n` +
      `💡 Tip: Run Lighthouse or web-vitals in the browser for runtime CWV measurement. ` +
      `Static analysis cannot detect runtime bottlenecks like long tasks, large images, or slow fonts.`
    );
  }

  const counts: Record<PerfImpact, number> = { high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.impact]++;

  const lines: string[] = [
    `⚡ Performance Hints — ${framework} ${context} (Core Web Vitals)`,
    `Found ${issues.length} issue(s): 🔴 ${counts.high} high  🟠 ${counts.medium} medium  🔵 ${counts.low} low`,
    ``,
  ];

  for (const issue of issues) {
    lines.push(
      `${IMPACT_ICON[issue.impact]} Line ${issue.line} — ${METRIC_EMOJI[issue.metric]} ${issue.metric}`,
      `   ${issue.message}`,
      `   Fix: ${issue.fix}`,
      ``,
    );
  }

  lines.push(
    `💡 Reasoning: Analyzed ${context} for Core Web Vitals issues (LCP, CLS, INP) and general ` +
      `performance anti-patterns. High-impact issues should be fixed first. ` +
      `Run Lighthouse (Chrome DevTools) for real-world CWV scores and use ` +
      `https://web.dev/measure/ for field data.`,
  );

  return lines.join("\n");
}
