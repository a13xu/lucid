import { z } from "zod";
import { resolve } from "path";
import type { Statements } from "../database.js";
import { indexProject, type IndexResult } from "../indexer/project.js";

export const InitProjectSchema = z.object({
  directory: z.string().optional(),
});

export type InitProjectInput = z.infer<typeof InitProjectSchema>;

export function handleInitProject(stmts: Statements, input: InitProjectInput): string {
  const dir = resolve(input.directory ?? process.cwd());
  const results: IndexResult[] = indexProject(dir, stmts);

  if (results.length === 0) {
    return `No indexable files found in: ${dir}\n\nExpected: CLAUDE.md, package.json, README.md, src/`;
  }

  const lines: string[] = [
    `✅ Project indexed: ${dir}`,
    ``,
    `Indexed ${results.length} source(s):`,
  ];

  for (const r of results) {
    lines.push(`  • [${r.type}] "${r.entity}" — ${r.observations} observation(s) from ${r.source}`);
  }

  lines.push(``);
  lines.push(`Knowledge graph updated. Use recall() to query project context.`);

  return lines.join("\n");
}
