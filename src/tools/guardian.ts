import { z } from "zod";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  validateFile,
  validateSource,
  formatReport,
  detectLanguage,
} from "../guardian/validator.js";
import { CHECKLIST } from "../guardian/checklist.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ValidateFileSchema = z.object({
  path: z.string().min(1),
});

export const CheckDriftSchema = z.object({
  code: z.string().min(1),
  language: z.enum(["python", "javascript", "typescript", "generic"]).optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleValidateFile(args: z.infer<typeof ValidateFileSchema>): string {
  const issues = validateFile(args.path);
  return formatReport(args.path, issues);
}

export function handleCheckDrift(args: z.infer<typeof CheckDriftSchema>): string {
  const lang = args.language ?? "generic";
  const extMap: Record<string, string> = {
    python: ".py",
    javascript: ".js",
    typescript: ".ts",
    generic: ".txt",
  };
  const ext = extMap[lang] ?? ".txt";
  const tmpPath = join(tmpdir(), `lucid-drift-${Date.now()}${ext}`);

  try {
    writeFileSync(tmpPath, args.code, "utf-8");
    const issues = validateSource(tmpPath, args.code, lang === "generic" ? undefined : lang);

    if (issues.length === 0) {
      return "✅ No drift patterns detected in this code snippet.";
    }

    const lines = [`Found ${issues.length} potential issue(s):\n`];
    for (const issue of issues) {
      const icon = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "ℹ️" }[issue.severity];
      lines.push(`${icon} [${issue.driftId}] line ${issue.line} — ${issue.message}`);
      if (issue.suggestion) lines.push(`   💡 ${issue.suggestion}`);
    }
    return lines.join("\n");
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export function handleGetChecklist(): string {
  return CHECKLIST;
}
