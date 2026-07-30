import { z } from "zod";
import type { Statements, FileContentRow } from "../database.js";
import { decompress } from "../store/content.js";

export const GrepCodeSchema = z.object({
  pattern:  z.string().min(1),
  language: z.enum(["python", "javascript", "typescript", "generic"]).optional(),
  context:  z.number().int().min(0).max(10).default(2),
});

export type GrepCodeInput = z.infer<typeof GrepCodeSchema>;

const MAX_MATCHES = 30;
const FTS_CANDIDATE_LIMIT = 400;

interface Match {
  filepath: string;
  line: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

type GrepRow = Pick<FileContentRow, "filepath" | "content" | "language" | "content_hash">;

/**
 * Literal seeds for the FTS pre-filter: maximal word-char runs from the regex,
 * minus a trailing char made optional by a quantifier. Seeds are OR-ed with
 * prefix wildcards, so they only ever widen the candidate set — never used as
 * a hard filter (FTS matches whole tokens; "sync" can't see "handleSyncFile").
 */
export function extractSeeds(pattern: string): string[] {
  const seeds: string[] = [];
  const re = /[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    let run = m[0]!;
    const next = pattern[re.lastIndex];
    if (next !== undefined && "?*{".includes(next)) run = run.slice(0, -1);
    if (run.length >= 3) seeds.push(run.toLowerCase());
  }
  return [...new Set(seeds)].slice(0, 8);
}

function scanRows(
  rows: GrepRow[],
  regex: RegExp,
  input: GrepCodeInput,
  matches: Match[]
): void {
  for (const file of rows) {
    if (matches.length >= MAX_MATCHES) return;
    if (input.language && file.language !== input.language) continue;

    let source: string;
    try {
      source = decompress(file.content as Buffer, file.content_hash);
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

      if (matches.length >= MAX_MATCHES) return;
    }
  }
}

export function handleGrepCode(stmts: Statements, input: GrepCodeInput): string {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, "i");
  } catch {
    return `Invalid regex pattern: ${input.pattern}`;
  }

  const matches: Match[] = [];
  const scannedPaths = new Set<string>();
  let totalFiles = 0;

  // Stage 1: FTS candidates from literal seeds (fast path)
  const seeds = extractSeeds(input.pattern);
  if (seeds.length > 0) {
    try {
      const ftsQuery = seeds.map((s) => `"${s}"*`).join(" OR ");
      const paths = stmts.searchFileFtsBM25.all(ftsQuery, FTS_CANDIDATE_LIMIT).map((r) => r.filepath);
      if (paths.length > 0) {
        const rows = stmts.getFilesByPaths.all(JSON.stringify(paths)) as GrepRow[];
        scanRows(rows, regex, input, matches);
        for (const r of rows) scannedPaths.add(r.filepath);
        totalFiles = rows.length;
      }
    } catch { /* FTS unavailable — stage 2 covers everything */ }
  }

  // Stage 2: full scan of whatever stage 1 didn't cover (only until the cap)
  if (matches.length < MAX_MATCHES) {
    const rest = (stmts.getAllFiles.all() as GrepRow[]).filter((r) => !scannedPaths.has(r.filepath));
    totalFiles += rest.length;
    scanRows(rest, regex, input, matches);
  }

  if (matches.length === 0) {
    return `No matches for /${input.pattern}/ in ${totalFiles} indexed file(s).`;
  }

  const lines: string[] = [
    `Found ${matches.length} match(es) for /${input.pattern}/ across ${totalFiles} file(s):\n`,
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
