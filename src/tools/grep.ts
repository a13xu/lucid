import { z } from "zod";
import type { Statements } from "../database.js";
import { decompress } from "../store/content.js";

export const GrepCodeSchema = z.object({
  pattern:  z.string().min(1),
  language: z.enum(["python", "javascript", "typescript", "generic"]).optional(),
  context:  z.number().int().min(0).max(10).default(2),
});

export type GrepCodeInput = z.infer<typeof GrepCodeSchema>;

interface Match {
  filepath: string;
  line: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

export function handleGrepCode(stmts: Statements, input: GrepCodeInput): string {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, "i");
  } catch {
    return `Invalid regex pattern: ${input.pattern}`;
  }

  const files = stmts.getAllFiles.all();
  const matches: Match[] = [];

  for (const file of files) {
    if (input.language && file.language !== input.language) continue;

    let source: string;
    try {
      source = decompress(file.content as Buffer);
    } catch {
      continue; // skip fișiere corupte
    }

    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;

      matches.push({
        filepath: file.filepath,
        line: i + 1,
        text: lines[i]!,
        contextBefore: lines.slice(Math.max(0, i - input.context), i),
        contextAfter:  lines.slice(i + 1, i + 1 + input.context),
      });

      if (matches.length >= 30) break; // cap la 30 match-uri
    }
    if (matches.length >= 30) break;
  }

  if (matches.length === 0) {
    return `No matches for /${input.pattern}/ in ${files.length} indexed file(s).`;
  }

  const lines: string[] = [
    `Found ${matches.length} match(es) for /${input.pattern}/ across ${files.length} file(s):\n`,
  ];

  let lastFile = "";
  for (const m of matches) {
    if (m.filepath !== lastFile) {
      lines.push(`── ${m.filepath}`);
      lastFile = m.filepath;
    }
    for (const l of m.contextBefore) lines.push(`  ${m.line - m.contextBefore.length + m.contextBefore.indexOf(l)}│ ${l}`);
    lines.push(`▶ ${m.line}│ ${m.text}`);
    for (const l of m.contextAfter)  lines.push(`  ${m.line + 1 + m.contextAfter.indexOf(l)}│ ${l}`);
    lines.push("");
  }

  return lines.join("\n");
}
