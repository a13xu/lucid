import { z } from "zod";
import { readFileSync } from "fs";
import { extname } from "path";
import { analyzeCodeQuality, formatQualityReport } from "../guardian/coding-analyzer.js";
import { CODING_RULES } from "../guardian/coding-rules.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CheckCodeQualitySchema = z
  .object({
    path: z.string().optional().describe("Absolute or relative path to the file to analyze."),
    code: z.string().optional().describe("Code snippet to analyze inline."),
    language: z
      .enum(["python", "javascript", "typescript", "vue", "generic"])
      .optional()
      .describe("Language hint. Auto-detected from file extension if path is provided."),
  })
  .refine((args) => args.path !== undefined || args.code !== undefined, {
    message: "Provide either path (file to read) or code (inline snippet).",
  });

// ---------------------------------------------------------------------------
// Extension → language map for synthetic snippet paths
// ---------------------------------------------------------------------------

const LANG_EXT: Record<string, string> = {
  python: ".py",
  javascript: ".js",
  typescript: ".ts",
  vue: ".vue",
  generic: ".txt",
};

// Languages where frontend rules activate (by extension)
const FRONTEND_EXTS = new Set([".tsx", ".jsx", ".vue"]);

function syntheticPath(lang: string): string {
  const ext = LANG_EXT[lang] ?? ".txt";
  return `<snippet>${ext}`;
}

function inferLang(filepath: string): string | undefined {
  const ext = extname(filepath).toLowerCase();
  const map: Record<string, string> = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".vue": "vue",
  };
  return map[ext];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetCodingRules(): string {
  return CODING_RULES;
}

export function handleCheckCodeQuality(args: z.infer<typeof CheckCodeQualitySchema>): string {
  let source: string;
  let filepath: string;
  let lang: string | undefined;

  if (args.path !== undefined) {
    try {
      source = readFileSync(args.path, "utf-8");
    } catch (err) {
      return `❌ Cannot read file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
    }
    filepath = args.path;
    // Explicit language overrides, otherwise infer from extension
    lang = args.language ?? inferLang(args.path);

    // Warn if extension is frontend but language was explicitly set to non-frontend
    const ext = extname(args.path).toLowerCase();
    if (FRONTEND_EXTS.has(ext) && lang && !["typescript", "javascript", "vue"].includes(lang)) {
      lang = inferLang(args.path) ?? lang;
    }
  } else {
    source = args.code!;
    lang = args.language ?? "generic";
    filepath = syntheticPath(lang);
  }

  const issues = analyzeCodeQuality(filepath, source, lang);
  return formatQualityReport(filepath, issues);
}
