import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const DesignTokensSchema = z.object({
  brand_name: z.string().describe("Brand/project name"),
  primary_color: z
    .string()
    .describe("Primary brand color as hex (e.g. #3B82F6) or color name (e.g. blue)"),
  mood: z
    .enum(["minimal", "bold", "playful", "corporate"])
    .describe("Design mood"),
  output_format: z
    .enum(["css-variables", "tailwind-config", "json"])
    .describe("Output format for the token set"),
});

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

/** Named colors to hex fallback map */
const NAMED_COLORS: Record<string, string> = {
  blue: "#3B82F6",
  indigo: "#6366F1",
  purple: "#8B5CF6",
  pink: "#EC4899",
  red: "#EF4444",
  orange: "#F97316",
  yellow: "#EAB308",
  green: "#22C55E",
  teal: "#14B8A6",
  cyan: "#06B6D4",
  slate: "#64748B",
  gray: "#6B7280",
  zinc: "#71717A",
  neutral: "#737373",
  stone: "#78716C",
};

function resolveHex(color: string): string {
  const trimmed = color.trim().toLowerCase();
  if (trimmed.startsWith("#")) return trimmed;
  return NAMED_COLORS[trimmed] ?? "#3B82F6";
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return [r ?? 0, g ?? 0, b ?? 0];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  const ll = l / 100, ss = s / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = ll - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Generate a 10-step color scale (50–950) from a base hex color */
function generateColorScale(baseHex: string): Record<string, string> {
  const [r, g, b] = hexToRgb(baseHex);
  const [h, s] = rgbToHsl(r, g, b);

  const steps: [string, number, number][] = [
    ["50",  s > 10 ? s - 10 : s, 97],
    ["100", s > 10 ? s - 5  : s, 94],
    ["200", s,                   86],
    ["300", s,                   74],
    ["400", s,                   62],
    ["500", s,                   50],
    ["600", s,                   41],
    ["700", s,                   34],
    ["800", s,                   27],
    ["900", s,                   20],
    ["950", s,                   14],
  ];

  const scale: Record<string, string> = {};
  for (const [name, sat, light] of steps) {
    scale[name] = hslToHex(h, sat, light);
  }
  return scale;
}

/** Pick a neutral (desaturated) scale based on primary hue */
function generateNeutralScale(primaryHex: string): Record<string, string> {
  const [r, g, b] = hexToRgb(primaryHex);
  const [h] = rgbToHsl(r, g, b);
  const neutralSteps: [string, number, number][] = [
    ["50",  8, 98], ["100", 8, 95], ["200", 8, 90], ["300", 8, 82], ["400", 7, 65],
    ["500", 6, 48], ["600", 5, 38], ["700", 5, 28], ["800", 4, 20], ["900", 4, 12], ["950", 3, 8],
  ];
  const scale: Record<string, string> = {};
  for (const [name, sat, light] of neutralSteps) {
    scale[name] = hslToHex(h, sat, light);
  }
  return scale;
}

// ---------------------------------------------------------------------------
// Mood configurations
// ---------------------------------------------------------------------------

interface MoodConfig {
  fontSans: string;
  fontMono: string;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusFull: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  spacingBase: number;
}

const MOOD_CONFIG: Record<string, MoodConfig> = {
  minimal: {
    fontSans: "'Inter', 'system-ui', sans-serif",
    fontMono: "'JetBrains Mono', 'Fira Code', monospace",
    radiusSm: "2px", radiusMd: "4px", radiusLg: "6px", radiusFull: "9999px",
    shadowSm: "0 1px 2px rgba(0,0,0,0.05)",
    shadowMd: "0 2px 8px rgba(0,0,0,0.08)",
    shadowLg: "0 4px 16px rgba(0,0,0,0.10)",
    spacingBase: 4,
  },
  bold: {
    fontSans: "'Poppins', 'Montserrat', sans-serif",
    fontMono: "'Roboto Mono', monospace",
    radiusSm: "4px", radiusMd: "8px", radiusLg: "12px", radiusFull: "9999px",
    shadowSm: "0 2px 4px rgba(0,0,0,0.15)",
    shadowMd: "0 4px 12px rgba(0,0,0,0.20)",
    shadowLg: "0 8px 24px rgba(0,0,0,0.25)",
    spacingBase: 4,
  },
  playful: {
    fontSans: "'Nunito', 'Quicksand', sans-serif",
    fontMono: "'Space Mono', monospace",
    radiusSm: "8px", radiusMd: "16px", radiusLg: "24px", radiusFull: "9999px",
    shadowSm: "2px 2px 0 rgba(0,0,0,0.10)",
    shadowMd: "4px 4px 0 rgba(0,0,0,0.12)",
    shadowLg: "6px 6px 0 rgba(0,0,0,0.15)",
    spacingBase: 4,
  },
  corporate: {
    fontSans: "'IBM Plex Sans', 'Arial', sans-serif",
    fontMono: "'IBM Plex Mono', monospace",
    radiusSm: "2px", radiusMd: "3px", radiusLg: "4px", radiusFull: "9999px",
    shadowSm: "0 1px 3px rgba(0,0,0,0.12)",
    shadowMd: "0 2px 6px rgba(0,0,0,0.15)",
    shadowLg: "0 4px 12px rgba(0,0,0,0.18)",
    spacingBase: 4,
  },
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatCssVariables(
  brand: string,
  primary: Record<string, string>,
  neutral: Record<string, string>,
  mc: MoodConfig,
): string {
  const sp = (n: number) => `${n * mc.spacingBase}px`;

  const primaryVars = Object.entries(primary)
    .map(([k, v]) => `  --color-primary-${k}: ${v};`)
    .join("\n");
  const neutralVars = Object.entries(neutral)
    .map(([k, v]) => `  --color-neutral-${k}: ${v};`)
    .join("\n");

  return `/* ${brand} Design Tokens */
:root {
  /* Colors — Primary */
${primaryVars}

  /* Colors — Neutral */
${neutralVars}

  /* Semantic colors */
  --color-bg:         var(--color-neutral-50);
  --color-bg-subtle:  var(--color-neutral-100);
  --color-surface:    #ffffff;
  --color-border:     var(--color-neutral-200);
  --color-text:       var(--color-neutral-900);
  --color-text-muted: var(--color-neutral-500);
  --color-accent:     var(--color-primary-500);
  --color-accent-hover: var(--color-primary-600);

  /* Typography */
  --font-sans: ${mc.fontSans};
  --font-mono: ${mc.fontMono};
  --text-xs:   0.75rem;
  --text-sm:   0.875rem;
  --text-base: 1rem;
  --text-lg:   1.125rem;
  --text-xl:   1.25rem;
  --text-2xl:  1.5rem;
  --text-3xl:  1.875rem;
  --text-4xl:  2.25rem;
  --leading-tight:  1.25;
  --leading-normal: 1.5;
  --leading-loose:  1.75;

  /* Spacing */
  --space-1:  ${sp(1)};
  --space-2:  ${sp(2)};
  --space-3:  ${sp(3)};
  --space-4:  ${sp(4)};
  --space-6:  ${sp(6)};
  --space-8:  ${sp(8)};
  --space-12: ${sp(12)};
  --space-16: ${sp(16)};
  --space-24: ${sp(24)};

  /* Border Radius */
  --radius-sm:   ${mc.radiusSm};
  --radius-md:   ${mc.radiusMd};
  --radius-lg:   ${mc.radiusLg};
  --radius-full: ${mc.radiusFull};

  /* Shadows */
  --shadow-sm: ${mc.shadowSm};
  --shadow-md: ${mc.shadowMd};
  --shadow-lg: ${mc.shadowLg};

  /* Transitions */
  --duration-fast:   150ms;
  --duration-normal: 250ms;
  --duration-slow:   400ms;
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
}`;
}

function formatTailwindConfig(
  brand: string,
  primary: Record<string, string>,
  neutral: Record<string, string>,
  mc: MoodConfig,
): string {
  const primaryEntries = Object.entries(primary)
    .map(([k, v]) => `        ${k}: "${v}",`)
    .join("\n");
  const neutralEntries = Object.entries(neutral)
    .map(([k, v]) => `        ${k}: "${v}",`)
    .join("\n");

  return `// tailwind.config.ts — ${brand} Design Tokens
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,vue,html}"],
  theme: {
    extend: {
      colors: {
        primary: {
${primaryEntries}
        },
        neutral: {
${neutralEntries}
        },
      },
      fontFamily: {
        sans: [${mc.fontSans.split(",").map((f) => `"${f.trim().replace(/'/g, "")}"`).join(", ")}],
        mono: [${mc.fontMono.split(",").map((f) => `"${f.trim().replace(/'/g, "")}"`).join(", ")}],
      },
      borderRadius: {
        sm:   "${mc.radiusSm}",
        md:   "${mc.radiusMd}",
        lg:   "${mc.radiusLg}",
        full: "${mc.radiusFull}",
      },
      boxShadow: {
        sm: "${mc.shadowSm}",
        md: "${mc.shadowMd}",
        lg: "${mc.shadowLg}",
      },
      spacing: {
        "1":  "4px",  "2":  "8px",  "3":  "12px", "4":  "16px",
        "6":  "24px", "8":  "32px", "12": "48px",  "16": "64px",
      },
    },
  },
  plugins: [],
};

export default config;`;
}

function formatJson(
  brand: string,
  primary: Record<string, string>,
  neutral: Record<string, string>,
  mc: MoodConfig,
): string {
  const tokens = {
    brand,
    colors: {
      primary: Object.fromEntries(Object.entries(primary).map(([k, v]) => [`primary.${k}`, v])),
      neutral: Object.fromEntries(Object.entries(neutral).map(([k, v]) => [`neutral.${k}`, v])),
      semantic: {
        "bg": neutral["50"],
        "bg-subtle": neutral["100"],
        "surface": "#ffffff",
        "border": neutral["200"],
        "text": neutral["900"],
        "text-muted": neutral["500"],
        "accent": primary["500"],
        "accent-hover": primary["600"],
      },
    },
    typography: {
      fontSans: mc.fontSans,
      fontMono: mc.fontMono,
      scale: { xs: "0.75rem", sm: "0.875rem", base: "1rem", lg: "1.125rem", xl: "1.25rem", "2xl": "1.5rem", "3xl": "1.875rem", "4xl": "2.25rem" },
    },
    spacing: { "1": "4px", "2": "8px", "3": "12px", "4": "16px", "6": "24px", "8": "32px", "12": "48px", "16": "64px" },
    radii: { sm: mc.radiusSm, md: mc.radiusMd, lg: mc.radiusLg, full: mc.radiusFull },
    shadows: { sm: mc.shadowSm, md: mc.shadowMd, lg: mc.shadowLg },
  };
  return JSON.stringify(tokens, null, 2);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleDesignTokens({ brand_name: "Acme", primary_color: "#6366F1", mood: "minimal", output_format: "css-variables" })

export function handleDesignTokens(args: z.infer<typeof DesignTokensSchema>): string {
  const { brand_name, primary_color, mood, output_format } = args;

  const primaryHex = resolveHex(primary_color);
  const primaryScale = generateColorScale(primaryHex);
  const neutralScale = generateNeutralScale(primaryHex);
  const mc = MOOD_CONFIG[mood] ?? MOOD_CONFIG["minimal"]!;

  let code: string;
  let lang: string;
  let filename: string;

  switch (output_format) {
    case "tailwind-config":
      code = formatTailwindConfig(brand_name, primaryScale, neutralScale, mc);
      lang = "typescript";
      filename = "tailwind.config.ts";
      break;
    case "json":
      code = formatJson(brand_name, primaryScale, neutralScale, mc);
      lang = "json";
      filename = "design-tokens.json";
      break;
    default: // css-variables
      code = formatCssVariables(brand_name, primaryScale, neutralScale, mc);
      lang = "css";
      filename = "tokens.css";
  }

  const lines: string[] = [
    `✅ Design tokens: ${brand_name}`,
    `📄 Filename: ${filename}`,
    `🎨 Primary: ${primaryHex} | Mood: ${mood} | Format: ${output_format}`,
    ``,
    "```" + lang,
    code,
    "```",
    ``,
    `💡 Reasoning: Generated a complete design token set from primary color ${primaryHex}. ` +
      `Color scales (50–950) derived via HSL lightness interpolation. ` +
      `Neutral scale uses the same hue with reduced saturation. ` +
      `Typography, spacing, radius, and shadow values tuned for "${mood}" mood. ` +
      `Review contrast ratios with a tool like https://webaim.org/resources/contrastchecker/.`,
  ];

  return lines.join("\n");
}
