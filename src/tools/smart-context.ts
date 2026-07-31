import { z } from "zod";
import type { Statements } from "../database.js";
import { assembleContext } from "../retrieval/context.js";
import { recallEntities, capEntity } from "./recall.js";
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

/** Compact per-entity render (name, type, capped observations, relations) that
 *  stops once the char budget is exhausted. */
function renderKnowledge(entities: ReturnType<typeof recallEntities>, maxChars: number): string {
  if (entities.length === 0) return "No matching entities in the knowledge graph.";

  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const raw of entities) {
    const e = capEntity(raw);
    const block: string[] = [`### ${e.name} (${e.type})`];
    for (const o of e.observations) block.push(`- ${o}`);
    if (e.relations.length > 0) {
      block.push(`- relations: ${e.relations.slice(0, 8).map((r) => `${r.from} —${r.type}→ ${r.to}`).join("; ")}`);
    }
    const text = block.join("\n") + "\n";
    if (shown > 0 && used + text.length > maxChars) break;
    lines.push(text);
    used += text.length;
    shown++;
  }
  if (shown < entities.length) {
    lines.push(`… +${entities.length - shown} more entities (use recall("<topic>") to inspect them)`);
  }
  return lines.join("\n");
}

export async function handleSmartContext(
  stmts: Statements,
  args: z.infer<typeof SmartContextSchema>
): Promise<string> {
  const cfg = loadConfig();
  const maxTokens = TASK_BUDGETS[args.task_type ?? "moderate"] ?? 6000;

  // Split the budget: knowledge graph gets 25%, code files the rest. Both
  // sections MUST stay bounded — the combined response has to fit the MCP
  // client's per-response token limit (~25k), regardless of graph size.
  const knowledgeBudgetChars = Math.floor(maxTokens * 0.25) * 4;
  const codeBudget = maxTokens - Math.floor(maxTokens * 0.25);

  // 1. Knowledge graph entities (synchronous, compact render within budget)
  const recallResult = renderKnowledge(recallEntities(stmts, args.query), knowledgeBudgetChars);

  // 2. Code context with adaptive budget (async)
  const contextResult = await assembleContext(args.query, stmts, cfg, {
    maxTokens: codeBudget,
    dirs: args.dirs,
  });

  // 3. Log experience so reward()/penalize() work after this call
  const expId = createExperience(
    args.query,
    contextResult.files.map((f) => f.filepath),
    contextResult.strategy,
    stmts
  );

  const budgetUsedPct = Math.round((contextResult.totalTokens / codeBudget) * 100);

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
