import { z } from "zod";
import type { Statements } from "../database.js";
import { assembleContext } from "../retrieval/context.js";
import { recall } from "./recall.js";
import { loadConfig } from "../config.js";
import { createExperience } from "../memory/experience.js";

export const SmartContextSchema = z.object({
  query: z.string().min(1).describe(
    "What you are working on — used for both code retrieval and knowledge graph search"
  ),
  task_type: z.enum(["simple", "moderate", "complex"]).optional().describe(
    "Token budget: simple=2000, moderate=6000 (default), complex=12000"
  ),
  dirs: z.array(z.string()).optional().describe(
    "Whitelist: only return files from these directories"
  ),
});

const TASK_BUDGETS: Record<string, number> = {
  simple:   2000,
  moderate: 6000,
  complex:  12000,
};

export async function handleSmartContext(
  stmts: Statements,
  args: z.infer<typeof SmartContextSchema>
): Promise<string> {
  const cfg = loadConfig();
  const maxTokens = TASK_BUDGETS[args.task_type ?? "moderate"] ?? 6000;

  // 1. Knowledge graph entities (synchronous)
  const recallResult = recall(stmts, { query: args.query });

  // 2. Code context with adaptive budget (async)
  const contextResult = await assembleContext(args.query, stmts, cfg, {
    maxTokens,
    dirs: args.dirs,
  });

  // 3. Log experience so reward()/penalize() work after this call
  const expId = createExperience(
    args.query,
    contextResult.files.map((f) => f.filepath),
    contextResult.strategy,
    stmts
  );

  const budgetUsedPct = Math.round((contextResult.totalTokens / maxTokens) * 100);

  const sections: string[] = [
    "## Knowledge Context (entities)",
    recallResult,
    "",
    "## Code Context (files)",
  ];

  if (contextResult.files.length === 0) {
    sections.push("No relevant files found. Run init_project() or sync_project() first.");
  } else {
    for (const f of contextResult.files) {
      sections.push(`// ─── ${f.filepath} [${f.language}] ~${f.tokens}t (${f.reason}) ───`);
      sections.push(f.content);
      sections.push("");
    }
    if (contextResult.truncated) {
      sections.push(
        `// ⚠️  Truncated — ${contextResult.skippedFiles} files skipped. Use task_type="complex" for more.`
      );
    }
  }

  sections.push("", "---");
  sections.push(`Strategy: ${contextResult.strategy}`);
  sections.push(`Files: ${contextResult.files.length} files, ${contextResult.totalTokens} tokens`);
  sections.push(`Budget used: ${budgetUsedPct}%`);
  sections.push(`Experience #${expId} logged. Call reward() if helpful, penalize() if not.`);

  return sections.join("\n");
}
